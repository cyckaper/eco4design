// 棲共生 · Claude API 代理（Netlify Edge Function / Deno）
// 目的：金鑰只存在伺服器端環境變數，瀏覽器完全看不到。
// 為什麼用 Edge Function：標準 serverless function 免費版約 10 秒逾時，
// 本分析需 3–8 分鐘。Edge Function 只要 40 秒內回傳 headers 就能持續串流，
// 且等待上游回應不計入 CPU 時間。Deno 執行環境不需 build/npm install，
// 因此可直接用拖拉方式部署。

import { getCatalog, parseModelId, supportsEffort, supportsDynamicTools, thinksByDefault } from '../shared/model-catalog.js';
import { relay } from '../shared/sse-relay.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// 可用模型不寫死：只允許模型目錄（../shared/model-catalog.js）中各系列最新一版，
// 避免有人改前端送出昂貴或未預期的模型；未指定或不在目錄中 → 用建議模型

const MAX_PROMPT_CHARS = 24000;   // 提示詞長度上限（防濫用）
// 輸出上限：新一代模型預設會先思考（思考 token 也計入），上限給得較寬；只依實際產生量計費
const MAX_TOKENS = 64000;
// 推理強度：分析用 high（多查、查得仔細，減少「未查得」），改寫只刪除與更正用 low
const EFFORT = { analyze: 'high', revise: 'low' };
// 網路工具：搜尋 ≤15 次（與 index.html 的 WEB_SEARCH_MAX 一致）；讀取網頁全文 ≤6 次（論文、政府文件中的數值多半不在搜尋摘要裡）。
// Sonnet／Opus 4.6 以上用可過濾結果的新版工具（先以程式篩出相關段落再放進內容，省 token）；Haiku 只搜尋（維持便宜、快速）。
const WEB_SEARCH_MAX = 15, WEB_FETCH_MAX = 6, FETCH_MAX_CONTENT_TOKENS = 15000;
function webTools(model) {
  if (supportsDynamicTools(model)) {
    return [
      { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: WEB_FETCH_MAX, max_content_tokens: FETCH_MAX_CONTENT_TOKENS, citations: { enabled: true } },
    ];
  }
  return [{ type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX }];
}

// mode: 'revise'（排除未通過查證的內容）：輸入是整份報告 <article> 加上排除清單，因此另有較高的長度上限；
// 不提供任何工具（不做網路搜尋）——改寫只能刪除與更正，不得引入未經查證的新資料。
// 防濫用（revise 不搜尋、回應較快，又接受較長的輸入）：
//   - 長度上限依實際報告量測（文章 ≤ 約 35,000 字元＋清單與指示），超過時前端改以自動規則過濾
//   - 只用目錄中最新的 Sonnet／Haiku（Opus 或其他一律改用 Sonnet）；max_tokens 依輸入長度縮小（輸出只會比原報告短）
//   - 提示詞必須恰好含一個 <<<REPORT … REPORT>>> 區塊，且區塊內恰好一份 <article>…</article>
//   - 每個來源 IP 每 10 分鐘最多 40 次（單一執行個體內的記憶體計數）；未設定通行碼時不提供
const MAX_REVISE_PROMPT_CHARS = 80000;
const REVISE_MIN_TOKENS = 4096;
const REVISE_RATE_WINDOW_MS = 10 * 60 * 1000, REVISE_RATE_MAX = 40;
const MODES = new Set(['analyze', 'revise']);
const reviseHits = new Map();
function reviseRateLimited(ip) {
  const now = Date.now();
  const arr = (reviseHits.get(ip) || []).filter(t => now - t < REVISE_RATE_WINDOW_MS);
  arr.push(now);
  reviseHits.set(ip, arr.slice(-REVISE_RATE_MAX - 1));
  if (reviseHits.size > 5000) reviseHits.clear();   // 記憶體上限：極端情況下整批重置
  return arr.length > REVISE_RATE_MAX;
}
// 報告區塊：<<<REPORT 與 REPORT>>> 各恰好一次、區塊位於提示詞末尾，且區塊內恰好一份 <article>…</article>
function reviseBlockOk(prompt) {
  const open = prompt.split('<<<REPORT').length - 1, close = prompt.split('REPORT>>>').length - 1;
  if (open !== 1 || close !== 1) return false;
  const a = prompt.indexOf('<<<REPORT'), b = prompt.indexOf('REPORT>>>');
  if (b < a || prompt.slice(b + 9).trim()) return false;
  const block = prompt.slice(a + 9, b);
  return (block.match(/<article\b/gi) || []).length === 1 && (block.match(/<\/article\s*>/gi) || []).length === 1 &&
    /^\s*<article\b/i.test(block) && /<\/article\s*>\s*$/i.test(block);
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }

  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  const PASSCODE = Deno.env.get('QI_PASSCODE');

  if (!API_KEY) {
    return json(500, {
      error: '伺服器尚未設定 ANTHROPIC_API_KEY 環境變數',
      hint: 'Netlify Dashboard → Site configuration → Environment variables',
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json(400, { error: '請求格式錯誤（非合法 JSON）' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, { error: '請求格式錯誤（應為 JSON 物件）' });
  }

  // ── 通行碼驗證（唯一能區分「授權使用者」與「路過機器人」的機制）──
  if (PASSCODE) {
    const given = typeof body.passcode === 'string' ? body.passcode.trim() : '';   // 非字串（物件等）一律視為未提供，避免 String() 拋出例外
    if (!given) {
      return json(401, { error: '需要通行碼', code: 'PASSCODE_REQUIRED' });
    }
    if (given !== PASSCODE) {
      return json(401, { error: '通行碼不正確', code: 'PASSCODE_INVALID' });
    }
  }

  // 未提供 mode → 原本的分析（含網路搜尋）；其他值一律拒絕，不默默改用預設
  const mode = body.mode == null ? 'analyze' : body.mode;
  if (!MODES.has(mode)) {
    return json(400, { error: '不支援的 mode', code: 'BAD_MODE' });
  }
  const revise = mode === 'revise';
  const maxChars = revise ? MAX_REVISE_PROMPT_CHARS : MAX_PROMPT_CHARS;
  // revise 只供本工具的查證流程使用：未設定通行碼的站台不提供（查證服務同樣不開放）
  if (revise && !PASSCODE) {
    return json(503, { error: '本站尚未設定 QI_PASSCODE，不提供改寫服務', code: 'NOT_CONFIGURED' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) {
    return json(400, { error: '提示詞為空' });
  }
  if (prompt.length > maxChars) {
    return json(413, { error: `提示詞過長（${prompt.length} 字元，上限 ${maxChars}）`, code: 'PROMPT_TOO_LONG' });
  }
  if (revise && !reviseBlockOk(prompt)) {
    return json(400, { error: '改寫請求格式不符（須恰好一份 <<<REPORT <article>…</article> REPORT>>> 區塊）', code: 'BAD_REVISE_PROMPT' });
  }
  if (revise) {
    const ip = (context && typeof context.ip === 'string' && context.ip) ||
      request.headers.get('x-nf-client-connection-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (reviseRateLimited(ip)) return new Response(JSON.stringify({ error: '改寫請求過於頻繁，請稍後再試', code: 'RATE_LIMITED' }),
      { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '120' } });
  }

  const catalog = await getCatalog(API_KEY);
  const inCatalog = id => typeof id === 'string' && catalog.models.some(m => m.id === id);
  const familyLatest = f => (catalog.models.find(m => m.family === f) || {}).id;
  let model;
  if (revise) {
    // 改寫：產生報告用 Haiku 時沿用 Haiku，其餘一律用最新的 Sonnet（不需要較貴的模型）
    const fam = inCatalog(body.model) && (parseModelId(body.model) || {}).family;
    model = (fam === 'haiku' ? body.model : familyLatest('sonnet')) || catalog.recommended;
  } else {
    model = inCatalog(body.model) ? body.model : catalog.recommended;
  }
  // revise 的輸出（修訂後的報告）只會比輸入短：上限依輸入長度縮小（預設會思考的模型多留思考空間）
  const maxTokens = revise
    ? Math.min(MAX_TOKENS, Math.max(REVISE_MIN_TOKENS, Math.ceil(prompt.length * 1.2)) + (thinksByDefault(model) ? 16000 : 0))
    : (/haiku/.test(model) ? 32000 : MAX_TOKENS);

  const messages = [{ role: 'user', content: prompt }];
  const callUpstream = msgs => fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,                     // 串流是關鍵：讓連線持續有資料流動，避開逾時
      ...(supportsEffort(model) ? { output_config: { effort: revise ? EFFORT.revise : EFFORT.analyze } } : {}),
      messages: msgs,
      // revise：不帶 tools，模型無法搜尋或取得新資料
      ...(revise ? {} : { tools: webTools(model) }),
    }),
  });
  let upstream;
  try {
    upstream = await callUpstream(messages);
  } catch (e) {
    return json(502, { error: '無法連線至 Anthropic API：' + (e?.message || String(e)) });
  }

  // 上游錯誤：在開始串流前攔截，才能回傳正確的 HTTP 狀態碼給前端判斷
  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch (_) { /* 讀不到錯誤內容：沿用預設訊息 */ }
    let message = `Anthropic API 錯誤（HTTP ${upstream.status}）`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch (_) {
      if (detail) message = detail.slice(0, 300);
    }
    return json(upstream.status, { error: message, upstreamStatus: upstream.status });
  }

  // 把 SSE 串流轉送給瀏覽器（搜尋迴圈暫停時自動接續、閒置時送 keepalive、網頁全文不轉送）；x-model：實際使用的模型，供前端記錄
  const outBody = revise ? upstream.body : relay(upstream, { userMessages: messages, next: callUpstream });
  return new Response(outBody, {
    status: 200,
    headers: {
      'x-model': model,
      'access-control-expose-headers': 'x-model',
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    },
  });
};

export const config = { path: '/api/analyze' };

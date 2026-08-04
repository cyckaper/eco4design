// 棲共生 · Claude API 代理（Netlify Edge Function / Deno）
// 目的：金鑰只存在伺服器端環境變數，瀏覽器完全看不到。
// 為什麼用 Edge Function：標準 serverless function 免費版約 10 秒逾時，
// 本分析需 3–8 分鐘。Edge Function 只要 40 秒內回傳 headers 就能持續串流，
// 且等待上游回應不計入 CPU 時間。Deno 執行環境不需 build/npm install，
// 因此可直接用拖拉方式部署。

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// 只允許這三個模型，避免有人改前端送出昂貴或未預期的模型
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
]);

const MAX_PROMPT_CHARS = 24000;   // 提示詞長度上限（防濫用）
const MAX_TOKENS = 32000;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async (request) => {
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

  // ── 通行碼驗證（唯一能區分「授權使用者」與「路過機器人」的機制）──
  if (PASSCODE) {
    const given = String(body.passcode || '').trim();
    if (!given) {
      return json(401, { error: '需要通行碼', code: 'PASSCODE_REQUIRED' });
    }
    if (given !== PASSCODE) {
      return json(401, { error: '通行碼不正確', code: 'PASSCODE_INVALID' });
    }
  }

  const prompt = String(body.prompt || '');
  if (!prompt.trim()) {
    return json(400, { error: '提示詞為空' });
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json(413, { error: `提示詞過長（${prompt.length} 字元，上限 ${MAX_PROMPT_CHARS}）` });
  }

  const model = ALLOWED_MODELS.has(body.model) ? body.model : 'claude-sonnet-4-6';

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        stream: true,                     // 串流是關鍵：讓連線持續有資料流動，避開逾時
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });
  } catch (e) {
    return json(502, { error: '無法連線至 Anthropic API：' + (e?.message || String(e)) });
  }

  // 上游錯誤：在開始串流前攔截，才能回傳正確的 HTTP 狀態碼給前端判斷
  if (!upstream.ok) {
    let detail = '';
    try { detail = await upstream.text(); } catch (_) {}
    let message = `Anthropic API 錯誤（HTTP ${upstream.status}）`;
    try {
      const parsed = JSON.parse(detail);
      if (parsed?.error?.message) message = parsed.error.message;
    } catch (_) {
      if (detail) message = detail.slice(0, 300);
    }
    return json(upstream.status, { error: message, upstreamStatus: upstream.status });
  }

  // 直接把 SSE 串流轉送給瀏覽器
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*',
    },
  });
};

export const config = { path: '/api/analyze' };

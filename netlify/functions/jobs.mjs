// 棲共生 · 分析背景工作：建立與輪詢
//
//   POST /api/jobs            { passcode, model?, prompt, lang? } → 202 { job, model }
//                             驗證與 /api/analyze 相同（通行碼、提示詞長度、模型只能是目錄中的）；
//                             把提示詞與狀態寫進 Blobs，再叫背景 Function（/api/analyze-bg）開始跑，馬上回工作編號。
//   GET  /api/jobs/<id>?from=N&wait=S
//                             → { id, status, model, from, next, chunks: [SSE 文字…], progress, heartbeatAgeMs, error?, usage?, stopReason? }
//                             從第 N 塊開始回傳（一次最多 12 塊）；還沒有新的就等最多 S 秒（≤ 15）再回。
//                             瀏覽器把 chunks 依序餵給原本的 SSE 解析器，斷線後帶著 next 再來就接得上。
//
// 為什麼是 Function 不是 Edge Function：Blobs 的讀寫在 Node Function 裡最單純（@netlify/blobs，不必任何設定），
// 而且長輪詢要等最多 15 秒，Function 的 26 秒上限綽綽有餘。
// 背景 Function 本身不能回資料（一律 202 空回應），所以建立工作的步驟放在這裡，通行碼錯誤等能馬上回給瀏覽器。

import { getCatalog } from '../shared/model-catalog.js';
import { MAX_PROMPT_CHARS } from '../shared/analyze-config.js';
import { openStore, newJobId, JOB_ID_RE, metaKey, promptKey, chunkKey, jobSecret, cleanupOldJobs, json } from '../shared/jobs-store.js';

const MAX_WAIT_S = 15;          // 長輪詢上限（Function 同步上限 26 秒，留餘裕給讀 Blobs）
const MAX_CHUNKS_PER_POLL = 12;
const CLEANUP_EVERY = 20;       // 每建立這麼多次工作就清一次兩天前的舊工作
let createCount = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function makeHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => new Date());

  return async (request, context) => {
    const url = new URL(request.url);
    const id = (context && context.params && context.params.id) || (url.pathname.match(/^\/api\/jobs\/([^/]+)\/?$/) || [])[1] || null;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
    }

    // ── 建立 ──
    if (request.method === 'POST' && !id) {
      const API_KEY = env.ANTHROPIC_API_KEY, PASSCODE = env.QI_PASSCODE;
      if (!API_KEY) return json(500, { error: '伺服器尚未設定 ANTHROPIC_API_KEY 環境變數', hint: 'Netlify Dashboard → Site configuration → Environment variables' });
      let body;
      try { body = await request.json(); } catch (_) { return json(400, { error: '請求格式錯誤（非合法 JSON）' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: '請求格式錯誤（應為 JSON 物件）' });
      if (PASSCODE) {
        const given = typeof body.passcode === 'string' ? body.passcode.trim() : '';
        if (!given) return json(401, { error: '需要通行碼', code: 'PASSCODE_REQUIRED' });
        if (given !== PASSCODE) return json(401, { error: '通行碼不正確', code: 'PASSCODE_INVALID' });
      }
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) return json(400, { error: '提示詞為空' });
      if (prompt.length > MAX_PROMPT_CHARS) return json(413, { error: `提示詞過長（${prompt.length} 字元，上限 ${MAX_PROMPT_CHARS}）`, code: 'PROMPT_TOO_LONG' });

      const catalog = await getCatalog(API_KEY);
      const model = typeof body.model === 'string' && catalog.models.some(m => m.id === body.model) ? body.model : catalog.recommended;
      const lang = body.lang === 'en' ? 'en' : 'zh';

      const store = await openStore(deps.store);
      const jobId = newJobId(now());
      const createdAt = now().toISOString();
      await store.set(promptKey(jobId), prompt);
      await store.setJSON(metaKey(jobId), {
        id: jobId, status: 'queued', createdAt, updatedAt: createdAt, model, lang, promptChars: prompt.length,
        chunks: 0, bytes: 0, invocations: 0, progress: { searches: 0, fetches: 0, chars: 0 },
      });
      // 叫背景 Function（同一個部署的網址；它只接受帶密鑰的呼叫）。202 就代表排進去了
      let invoked = false, why = '';
      try {
        const r = await fetchImpl(new URL('/api/analyze-bg', url.origin).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-job-secret': await jobSecret(env) },
          body: JSON.stringify({ id: jobId }),
        });
        invoked = r.status === 202 || r.ok;
        if (!invoked) why = 'HTTP ' + r.status;
      } catch (e) { why = String(e && e.message || e); }
      if (!invoked) {
        await store.setJSON(metaKey(jobId), { id: jobId, status: 'failed', createdAt, updatedAt: now().toISOString(), model, lang, chunks: 0, bytes: 0, invocations: 0,
          error: { message: '無法啟動背景分析：' + why, code: 'BG_UNAVAILABLE' } });
        return json(502, { error: '無法啟動背景分析', code: 'BG_UNAVAILABLE', detail: why });
      }
      if (++createCount % CLEANUP_EVERY === 0) { try { await cleanupOldJobs(store, now()); } catch (_) { /* 清理失敗不影響建立 */ } }
      return json(202, { job: jobId, model, createdAt });
    }

    // ── 輪詢 ──
    if (request.method === 'GET' && id) {
      if (!JOB_ID_RE.test(id)) return json(400, { error: '工作編號格式錯誤' });
      const store = await openStore(deps.store);
      const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
      const wait = Math.min(MAX_WAIT_S, Math.max(0, parseInt(url.searchParams.get('wait') || '0', 10) || 0));
      let meta = await store.get(metaKey(id), { type: 'json' });
      if (!meta) return json(404, { error: '找不到這個分析工作（可能已超過保留期限）', code: 'JOB_NOT_FOUND' });
      const deadline = Date.now() + wait * 1000;
      while (meta.status !== 'done' && meta.status !== 'failed' && meta.chunks <= from && Date.now() < deadline) {
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
        meta = (await store.get(metaKey(id), { type: 'json' })) || meta;
      }
      const to = Math.min(meta.chunks, from + MAX_CHUNKS_PER_POLL);
      const chunks = await Promise.all(Array.from({ length: Math.max(0, to - from) }, (_, i) => store.get(chunkKey(id, from + i), { type: 'text' }).then(x => x || '')));
      const heartbeatAgeMs = Math.max(0, Date.now() - (Date.parse(meta.updatedAt) || Date.now()));
      return json(200, {
        id, status: meta.status, model: meta.model, lang: meta.lang, from, next: to, total: meta.chunks, chunks,
        progress: meta.progress || null, heartbeatAgeMs, invocations: meta.invocations || 0,
        startedAt: meta.startedAt || null, finishedAt: meta.finishedAt || null,
        ...(meta.error ? { error: meta.error } : {}), ...(meta.usage ? { usage: meta.usage } : {}), ...(meta.stopReason ? { stopReason: meta.stopReason } : {}),
      });
    }

    return json(405, { error: 'Method not allowed' });
  };
}

export default makeHandler();
export const config = { path: ['/api/jobs', '/api/jobs/:id'] };

// 棲共生 · 分析背景工作的執行者（Netlify Background Function：回 202 後最多可跑 15 分鐘）
//
//   POST /api/analyze-bg   { id, resume? }   標頭 x-job-secret（見 jobs-store.js 的 jobSecret）
//
// 做的事與 edge-functions/analyze.js 的串流路徑相同（同一份 analyze-config、同一個 pause_turn 接續邏輯），
// 只是結果不是寫回瀏覽器，而是把 SSE 事件文字一塊一塊寫進 Blobs（j/<id>/c/000000…），
// 瀏覽器用 /api/jobs/<id> 輪詢取回、餵給原本的解析器。
//
// 時間：背景 Function 單次上限 15 分鐘。跑到 13.5 分鐘還沒完，就中止上游串流、把目前為止組好的 assistant 內容
// 存進 meta.resume，再呼叫自己一次（resume）；下一個執行個體把這些內容當作 assistant 的開頭送回 API 續寫
// （與 pause_turn 的接續完全相同）。瀏覽器看到的仍是一條連續的串流。
//
// 冪等：Netlify 對出錯的背景呼叫會在 1、2 分鐘後重試；這裡所有錯誤都寫進 meta 後正常結束，不會觸發重試。
// 萬一同一個工作被重複叫到（例如被強制終止後的重試），看到 meta 仍是 running 且心跳在 90 秒內就直接離開。

import { ANTHROPIC_URL, analyzeUserMessages, analyzeRequestBody, anthropicHeaders } from '../shared/analyze-config.js';
import { makeAssembler, slimEvent, addUsage } from '../shared/sse-relay.js';
import { openStore, metaKey, promptKey, chunkKey, jobSecret, json } from '../shared/jobs-store.js';

export const BG_BUDGET_MS = 13.5 * 60 * 1000;   // 單一執行個體的時間預算（上限 15 分鐘）
export const MAX_CONTINUATIONS = 4;             // pause_turn 接續次數上限（與 sse-relay 相同）
export const MAX_INVOCATIONS = 4;               // 接力續跑的執行個體上限（4 × 13.5 分鐘 ≈ 54 分鐘）
const CHUNK_BYTES = 32 * 1024;                  // 每塊 SSE 文字的目標大小
const CHUNK_MS = 5000;                          // 最久多久寫一塊（有內容時）
const HEARTBEAT_MS = 20000;                     // 沒有新內容時多久更新一次心跳（Anthropic 的 ping 事件不寫進塊裡）
const STALE_MS = 90000;                         // 心跳超過這麼久才允許另一個執行個體接手

const sse = ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;

export function makeRunner(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const budgetMs = deps.budgetMs || BG_BUDGET_MS;

  // 跑一個工作（或接力續跑）。origin：這個部署的網址，接力時呼叫自己用
  async function runJob(id, { resume = false, origin = '' } = {}) {
    const store = await openStore(deps.store);
    const meta = await store.get(metaKey(id), { type: 'json' });
    if (!meta) return { skipped: 'no_meta' };
    if (meta.status === 'done' || meta.status === 'failed') return { skipped: meta.status };
    if (meta.status === 'running' && !resume) {
      if (now() - (Date.parse(meta.updatedAt) || 0) < STALE_MS) return { skipped: 'active' };
      // 心跳早就停了、又不是接力：前一個執行個體被終止（逾時等）。不從頭重跑（已寫出的塊會和新內容接在一起），標成失敗
      Object.assign(meta, { status: 'failed', finishedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
        error: { message: '背景分析的執行個體中斷（逾時或被終止），請重新分析', code: 'BG_INTERRUPTED' } });
      await store.setJSON(metaKey(id), meta);
      return { failed: 'interrupted' };
    }
    const prompt = await store.get(promptKey(id), { type: 'text' });
    if (!prompt) { await save({ status: 'failed', error: { message: '找不到提示詞', code: 'NO_PROMPT' } }); return { failed: 'no_prompt' }; }

    const invocationStart = now();
    const model = meta.model;
    let cache = meta.cache !== false;
    let total = (meta.resume && meta.resume.usage) || {};
    let round = (meta.resume && meta.resume.round) || 0;
    const userMessages = () => analyzeUserMessages(prompt, cache);
    let messages = userMessages();
    if (meta.resume && Array.isArray(meta.resume.content) && meta.resume.content.length) messages = [...userMessages(), { role: 'assistant', content: meta.resume.content }];
    meta.status = 'running';
    meta.startedAt = meta.startedAt || new Date(now()).toISOString();
    meta.invocations = (meta.invocations || 0) + 1;
    meta.progress = meta.progress || { searches: 0, fetches: 0, chars: 0 };
    delete meta.resume;
    await save({});

    // 寫塊：整數個事件；達到大小或時間就寫；心跳另外算
    let buf = '', lastFlush = now(), lastBeat = now();
    async function flush(force) {
      if (!buf || (!force && buf.length < CHUNK_BYTES && now() - lastFlush < CHUNK_MS)) return;
      const seq = meta.chunks || 0;
      await store.set(chunkKey(id, seq), buf);
      meta.chunks = seq + 1; meta.bytes = (meta.bytes || 0) + buf.length;
      buf = ''; lastFlush = now(); lastBeat = now();
      await save({});
    }
    async function beat() {
      if (now() - lastBeat < HEARTBEAT_MS) return;
      lastBeat = now();
      await save({});
    }
    async function save(patch) {
      Object.assign(meta, patch, { updatedAt: new Date(now()).toISOString() });
      await store.setJSON(metaKey(id), meta);
    }
    const emit = ev => { buf += sse(ev); };
    const fail = async (message, extra) => {
      emit({ type: 'error', error: { type: 'job_error', message } });
      await flush(true);
      await save({ status: 'failed', finishedAt: new Date(now()).toISOString(), error: { message, ...(extra || {}) } });
    };

    const asm = makeAssembler();
    let lastStop = meta.stopReason || '';
    const callUpstream = msgs => fetchImpl(ANTHROPIC_URL, { method: 'POST', headers: anthropicHeaders(env.ANTHROPIC_API_KEY), body: JSON.stringify(analyzeRequestBody(model, msgs, cache)) });

    try {
      let res = await callUpstream(messages);
      if (cache && res.status === 400) {
        const detail = await res.clone().text().catch(() => '');
        if (/cache_control/i.test(detail)) { cache = false; meta.cache = false; messages = messages[0] && messages.length > 1 ? [...userMessages(), messages[1]] : userMessages(); res = await callUpstream(messages); }
      }
      if (!res.ok) {
        let detail = ''; try { detail = await res.text(); } catch (_) {}
        let message = `Anthropic API 錯誤（HTTP ${res.status}）`;
        try { const p = JSON.parse(detail); if (p && p.error && p.error.message) message = p.error.message; } catch (_) { if (detail) message = detail.slice(0, 300); }
        await fail(message, { status: res.status, upstreamStatus: res.status });
        return { failed: 'upstream', status: res.status };
      }

      let cur = {};
      while (true) {
        let held = [], pause = false, chained = false;
        cur = {};
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let sbuf = '';
        const handle = async raw => {
          const line = raw.split('\n').find(l => l.startsWith('data:'));
          if (!line) return;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
          asm.onEvent(ev);
          if (ev.type === 'ping') return;                       // 心跳由 beat() 處理，不寫進塊
          if (ev.type === 'message_start') {
            cur = addUsage({}, ev.message && ev.message.usage);
            if (round > 0) return;                              // 接續／接力的 message_start 不轉送（瀏覽器看到同一則訊息）
          }
          if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'server_tool_use') {
            if (ev.content_block.name === 'web_fetch') meta.progress.fetches++; else meta.progress.searches++;
          }
          if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') meta.progress.chars += ev.delta.text.length;
          if (ev.type === 'message_delta') {
            if (ev.usage) for (const k of Object.keys(ev.usage)) cur[k] = ev.usage[k];
            if (ev.delta && ev.delta.stop_reason) lastStop = ev.delta.stop_reason;
            const out = { ...ev, usage: addUsage(addUsage({}, total), cur) };
            if (ev.delta && ev.delta.stop_reason === 'pause_turn' && round < MAX_CONTINUATIONS) { pause = true; held.push(out); return; }
            emit(out); return;
          }
          if (ev.type === 'message_stop' && pause) { held.push(ev); return; }
          emit(slimEvent(ev));
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sbuf += dec.decode(value, { stream: true });
          let i;
          while ((i = sbuf.indexOf('\n\n')) >= 0) { const raw = sbuf.slice(0, i); sbuf = sbuf.slice(i + 2); await handle(raw); }
          await flush(false);
          await beat();
          // 時間預算到了：把這個執行個體收掉，讓下一個接力
          if (now() - invocationStart > budgetMs) { chained = true; try { await reader.cancel(); } catch (_) {} break; }
        }
        if (!chained && sbuf.trim()) await handle(sbuf);

        if (chained) {
          addUsage(total, cur);
          await flush(true);
          if (meta.invocations >= MAX_INVOCATIONS) {
            await fail(`分析超過 ${Math.round(MAX_INVOCATIONS * budgetMs / 60000)} 分鐘仍未完成，已停止`, { code: 'TOO_LONG' });
            return { failed: 'too_long' };
          }
          await save({ status: 'running', resume: { content: asm.contentForResume(), usage: total, round: Math.max(1, round) }, cache });
          const r = await fetchImpl(new URL('/api/analyze-bg', origin || env.URL || 'https://eco4design.healsdesign.org').toString(), {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-job-secret': await jobSecret(env) }, body: JSON.stringify({ id, resume: true }),
          }).catch(() => null);
          if (!r || !(r.status === 202 || r.ok)) { await fail('接力續跑失敗（無法再次啟動背景 Function）', { code: 'CHAIN_FAILED' }); return { failed: 'chain' }; }
          return { chained: true };
        }
        if (!pause) break;
        // pause_turn 接續：送回目前為止的 assistant 內容（不加 user 訊息），模型從暫停處繼續
        addUsage(total, cur);
        round++;
        let r2 = null;
        try { r2 = await callUpstream([...userMessages(), { role: 'assistant', content: asm.content() }]); } catch (_) { r2 = null; }
        if (!r2 || !r2.ok || !r2.body) {
          for (const ev of held) emit(ev);     // 接續失敗：照原樣結束（pause_turn → 前端標示報告可能不完整）
          break;
        }
        res = r2;
      }
      // 完成（最後一輪的用量也加進總數）
      addUsage(total, cur);
      await flush(true);
      await save({ status: 'done', finishedAt: new Date(now()).toISOString(), usage: total, ...(lastStop ? { stopReason: lastStop } : {}), blocks: asm.content().length });
      return { done: true };
    } catch (e) {
      await fail('背景分析中斷：' + (e && e.message || String(e)), { code: 'BG_ERROR' });
      return { failed: 'error' };
    }
  }

  return runJob;
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const env = process.env;
  const given = request.headers.get('x-job-secret') || '';
  if (!given || given !== await jobSecret(env)) return json(403, { error: 'Forbidden' });
  let body;
  try { body = await request.json(); } catch (_) { return json(400, { error: 'bad json' }); }
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!/^\d{8}-[0-9a-f]{24}$/.test(id)) return json(400, { error: 'bad id' });
  const run = makeRunner();
  await run(id, { resume: body.resume === true, origin: new URL(request.url).origin });
  return new Response(null, { status: 202 });
};

export const config = { path: '/api/analyze-bg', background: true };

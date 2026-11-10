// 分析背景工作：建立／輪詢（functions/jobs.mjs）與背景執行者（functions/analyze-bg.mjs）
//   node test/jobs.test.mjs
// 不打網路：Anthropic 與自我呼叫的 fetch 都換成假的；Blobs 換成記憶體 store。
import { makeHandler } from '../netlify/functions/jobs.mjs';
import { makeRunner } from '../netlify/functions/analyze-bg.mjs';
import { memoryStore, metaKey, promptKey, chunkKey, jobSecret, cleanupOldJobs, newJobId } from '../netlify/shared/jobs-store.js';
import { MAX_PROMPT_CHARS } from '../netlify/shared/analyze-config.js';

const results = [];
let failed = 0;
const check = (name, pass, got) => { results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`); if (!pass) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ENV = { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', QI_PASSCODE: 'test-pass' };
const SECRET = await jobSecret(ENV);
const sse = events => events.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
// 慢速串流：每個事件之間等 gapMs，模擬模型邊想邊寫
const slowStream = (events, gapMs = 0) => new ReadableStream({
  async start(c) {
    const enc = new TextEncoder();
    for (const ev of events) { c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)); if (gapMs) await sleep(gapMs); }
    c.close();
  },
});
const okStream = (events, gapMs) => new Response(slowStream(events, gapMs), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const endTurn = (text, extra = []) => [
  { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'A' }] } },
  { type: 'content_block_stop', index: 1 },
  ...extra,
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 20 } },
  { type: 'message_stop' },
];
// 模型目錄：getCatalog 會打 Models API → 假的 fetch 回一份目錄
const catalogResponse = () => new Response(JSON.stringify({ data: [
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z' },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
] }), { status: 200, headers: { 'content-type': 'application/json' } });

// ───────────────────────── jobs.mjs：建立 ─────────────────────────
{
  const store = memoryStore();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('api.anthropic.com/v1/models')) return catalogResponse();
    if (u.endsWith('/api/analyze-bg')) { calls.push({ url: u, headers: init.headers, body: JSON.parse(init.body) }); return new Response(null, { status: 202 }); }
    throw new Error('unexpected fetch ' + u);
  };
  const handler = makeHandler({ store, fetch: fetchImpl, env: ENV });
  const post = body => handler(new Request('https://site.test/api/jobs', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), {});
  let r = await post({ prompt: 'x' });
  check('建立：沒有通行碼 → 401 PASSCODE_REQUIRED', r.status === 401 && (await r.json()).code === 'PASSCODE_REQUIRED', r.status);
  r = await post({ prompt: 'x', passcode: 'wrong' });
  check('建立：通行碼錯 → 401 PASSCODE_INVALID', r.status === 401 && (await r.json()).code === 'PASSCODE_INVALID', r.status);
  r = await post({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1), passcode: 'test-pass' });
  check('建立：提示詞過長 → 413', r.status === 413, r.status);
  r = await post({ prompt: '   ', passcode: 'test-pass' });
  check('建立：空提示詞 → 400', r.status === 400, r.status);
  r = await post({ prompt: '請分析這個基地', passcode: 'test-pass', model: 'claude-opus-9-9', lang: 'zh' });
  const j = await r.json();
  check('建立成功：202、工作編號格式 yyyymmdd-24hex、模型不在目錄 → 用建議模型', r.status === 202 && /^\d{8}-[0-9a-f]{24}$/.test(j.job) && j.model === 'claude-sonnet-5-5', JSON.stringify(j));
  const meta = await store.get(metaKey(j.job), { type: 'json' });
  const prompt = await store.get(promptKey(j.job), { type: 'text' });
  check('建立成功：meta queued、提示詞存進 Blobs', meta && meta.status === 'queued' && meta.model === 'claude-sonnet-5-5' && meta.chunks === 0 && prompt === '請分析這個基地', JSON.stringify(meta));
  check('建立成功：呼叫了背景 Function，帶密鑰與工作編號', calls.length === 1 && calls[0].url === 'https://site.test/api/analyze-bg' && calls[0].headers['x-job-secret'] === SECRET && calls[0].body.id === j.job, JSON.stringify(calls));
  // 背景 Function 叫不起來 → 502，meta failed
  const handler2 = makeHandler({ store, env: ENV, fetch: async u => String(u).includes('/v1/models') ? catalogResponse() : new Response('nope', { status: 500 }) });
  r = await handler2(new Request('https://site.test/api/jobs', { method: 'POST', body: JSON.stringify({ prompt: 'p', passcode: 'test-pass' }) }), {});
  const j2 = await r.json();
  check('背景 Function 回 500 → 建立回 502 BG_UNAVAILABLE', r.status === 502 && j2.code === 'BG_UNAVAILABLE', JSON.stringify(j2));
  const failedMetas = (await store.list({ prefix: 'j/' })).blobs.filter(b => b.key.endsWith('/meta')).length;
  check('失敗的工作也留下 meta（failed）', failedMetas === 2, failedMetas);
}

// ───────────────────────── jobs.mjs：輪詢 ─────────────────────────
{
  const store = memoryStore();
  const id = newJobId(new Date('2026-11-10T01:00:00Z'));
  await store.setJSON(metaKey(id), { id, status: 'running', createdAt: 'x', updatedAt: new Date().toISOString(), model: 'm', lang: 'zh', chunks: 2, bytes: 10, progress: { searches: 3, fetches: 1, chars: 120 } });
  await store.set(chunkKey(id, 0), 'event: a\ndata: {"type":"a"}\n\n');
  await store.set(chunkKey(id, 1), 'event: b\ndata: {"type":"b"}\n\n');
  const handler = makeHandler({ store, env: ENV, fetch: async () => { throw new Error('no network'); } });
  const get = (path) => handler(new Request('https://site.test' + path), { params: { id } });
  let r = await handler(new Request('https://site.test/api/jobs/nope'), { params: { id: 'nope' } });
  check('輪詢：編號格式錯 → 400', r.status === 400, r.status);
  r = await handler(new Request(`https://site.test/api/jobs/${newJobId()}`), { params: { id: newJobId() } });
  check('輪詢：不存在 → 404 JOB_NOT_FOUND', r.status === 404 && (await r.json()).code === 'JOB_NOT_FOUND', r.status);
  r = await get(`/api/jobs/${id}?from=0`);
  let b = await r.json();
  check('輪詢：從 0 開始拿到兩塊、next=2、進度與心跳', r.status === 200 && b.chunks.length === 2 && b.chunks[0].startsWith('event: a') && b.next === 2 && b.total === 2 && b.progress.searches === 3 && b.heartbeatAgeMs < 5000 && b.status === 'running', JSON.stringify(b).slice(0, 300));
  // 長輪詢：0.4 秒後才有第三塊
  setTimeout(async () => { await store.set(chunkKey(id, 2), 'event: c\ndata: {"type":"c"}\n\n'); const m = await store.get(metaKey(id), { type: 'json' }); m.chunks = 3; m.updatedAt = new Date().toISOString(); await store.setJSON(metaKey(id), m); }, 400);
  const t0 = Date.now();
  r = await get(`/api/jobs/${id}?from=2&wait=5`);
  b = await r.json();
  const dt = Date.now() - t0;
  check('長輪詢：等到新的一塊才回（約 0.4–2 秒），而不是空手等滿 5 秒', b.chunks.length === 1 && b.chunks[0].startsWith('event: c') && b.next === 3 && dt >= 350 && dt < 3000, `${dt}ms ${JSON.stringify(b.chunks)}`);
  // 完成：wait 不等
  const m = await store.get(metaKey(id), { type: 'json' }); m.status = 'done'; m.usage = { output_tokens: 20 }; m.stopReason = 'end_turn'; await store.setJSON(metaKey(id), m);
  const t1 = Date.now();
  r = await get(`/api/jobs/${id}?from=3&wait=5`);
  b = await r.json();
  check('完成的工作：馬上回 done（不等）、附 usage 與 stopReason、沒有新塊', b.status === 'done' && b.chunks.length === 0 && b.usage.output_tokens === 20 && b.stopReason === 'end_turn' && Date.now() - t1 < 500, JSON.stringify(b));
}

// ───────────────────────── analyze-bg.mjs：正常完成 ─────────────────────────
{
  const store = memoryStore();
  const id = newJobId();
  const sent = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('api.anthropic.com/v1/messages')) { sent.push(JSON.parse(init.body)); return okStream(endTurn('<article><h1>報告</h1></article>')); }
    throw new Error('unexpected fetch ' + u);
  };
  await store.set(promptKey(id), '提示詞');
  await store.setJSON(metaKey(id), { id, status: 'queued', createdAt: 'x', updatedAt: 'x', model: 'claude-sonnet-5-5', lang: 'zh', chunks: 0, bytes: 0, invocations: 0 });
  const run = makeRunner({ store, fetch: fetchImpl, env: ENV });
  const out = await run(id, { origin: 'https://site.test' });
  const meta = await store.get(metaKey(id), { type: 'json' });
  const all = [];
  for (let i = 0; i < meta.chunks; i++) all.push(await store.get(chunkKey(id, i), { type: 'text' }));
  const text = all.join('');
  check('正常完成：meta done、用量加總、stopReason、進度（1 次搜尋、30 字）', out.done && meta.status === 'done' && meta.usage.output_tokens === 20 && meta.usage.cache_read_input_tokens === 4000 && meta.stopReason === 'end_turn' && meta.progress.searches === 1 && meta.progress.chars === 30 && meta.invocations === 1, JSON.stringify({ out, status: meta.status, usage: meta.usage, progress: meta.progress }));
  check('塊串起來就是 SSE 串流：含 message_start、text_delta、message_delta（含加總用量）、message_stop；ping 不寫', /event: message_start/.test(text) && /"text":"<article><h1>報告<\/h1><\/article>"/.test(text) && /"cache_read_input_tokens":4000/.test(text) && /event: message_stop/.test(text) && !/"type":"ping"/.test(text), text.slice(0, 400));
  check('每一塊都是整數個事件（以空行結尾）', all.every(c => c.endsWith('\n\n')), JSON.stringify(all.map(c => c.slice(-10))));
  check('送給 Anthropic 的請求：串流、提示快取、工具、effort high', sent.length === 1 && sent[0].stream === true && sent[0].messages[0].content[0].cache_control && sent[0].tools.length >= 1 && sent[0].output_config && sent[0].output_config.effort === 'high', JSON.stringify(sent[0]).slice(0, 300));
  const again = await run(id, { origin: 'https://site.test' });
  check('已完成的工作再被叫到：直接跳過（冪等）', again.skipped === 'done', JSON.stringify(again));
}

// ───────────────────────── analyze-bg.mjs：pause_turn 接續 ─────────────────────────
{
  const store = memoryStore();
  const id = newJobId();
  const sent = [];
  const first = [
    { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<article>' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 100, output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  const second = [
    { type: 'message_start', message: { usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<h1>續</h1></article>' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 15 } },
    { type: 'message_stop' },
  ];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return okStream(sent.length === 1 ? first : second); };
  await store.set(promptKey(id), 'p');
  await store.setJSON(metaKey(id), { id, status: 'queued', createdAt: 'x', updatedAt: 'x', model: 'claude-sonnet-5-5', lang: 'zh', chunks: 0, bytes: 0, invocations: 0 });
  await makeRunner({ store, fetch: fetchImpl, env: ENV })(id, { origin: 'https://site.test' });
  const meta = await store.get(metaKey(id), { type: 'json' });
  let text = ''; for (let i = 0; i < meta.chunks; i++) text += await store.get(chunkKey(id, i), { type: 'text' });
  check('pause_turn：接續請求帶回 assistant 內容，瀏覽器只看到一次 message_start、沒有 pause_turn', sent.length === 2 && sent[1].messages[1].role === 'assistant' && sent[1].messages[1].content[0].text === '<article>' && (text.match(/event: message_start/g) || []).length === 1 && !/pause_turn/.test(text) && /end_turn/.test(text), JSON.stringify({ n: sent.length, text: text.slice(-200) }));
  check('pause_turn：用量跨兩輪加總（output 25、cache_read 1100）', meta.usage.output_tokens === 25 && meta.usage.cache_read_input_tokens === 1100 && /"output_tokens":25/.test(text), JSON.stringify(meta.usage));
}

// ───────────────────────── analyze-bg.mjs：上游錯誤 ─────────────────────────
{
  const store = memoryStore();
  const id = newJobId();
  await store.set(promptKey(id), 'p');
  await store.setJSON(metaKey(id), { id, status: 'queued', createdAt: 'x', updatedAt: 'x', model: 'claude-sonnet-5-5', lang: 'zh', chunks: 0, bytes: 0, invocations: 0 });
  const fetchImpl = async () => new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
  const out = await makeRunner({ store, fetch: fetchImpl, env: ENV })(id, { origin: 'https://site.test' });
  const meta = await store.get(metaKey(id), { type: 'json' });
  const c0 = await store.get(chunkKey(id, 0), { type: 'text' });
  check('上游 529：meta failed（status 529、訊息 Overloaded）、塊裡有 error 事件', out.failed === 'upstream' && meta.status === 'failed' && meta.error.status === 529 && /Overloaded/.test(meta.error.message) && /event: error/.test(c0 || ''), JSON.stringify(meta.error));
}

// ───────────────────────── analyze-bg.mjs：接力續跑（時間預算） ─────────────────────────
{
  const store = memoryStore();
  const id = newJobId();
  const sent = [], selfCalls = [];
  const longEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...Array.from({ length: 12 }, (_, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `第${i}段。` } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 30 } },
    { type: 'message_stop' },
  ];
  const finishEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '結尾</article>' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 8 } },
    { type: 'message_stop' },
  ];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/analyze-bg')) { selfCalls.push(JSON.parse(init.body)); return new Response(null, { status: 202 }); }
    sent.push(JSON.parse(init.body));
    return okStream(sent.length === 1 ? longEvents : finishEvents, sent.length === 1 ? 40 : 0);   // 第一輪慢慢吐（12 段 × 40 ms）
  };
  await store.set(promptKey(id), 'p');
  await store.setJSON(metaKey(id), { id, status: 'queued', createdAt: 'x', updatedAt: 'x', model: 'claude-sonnet-5-5', lang: 'zh', chunks: 0, bytes: 0, invocations: 0 });
  const run = makeRunner({ store, fetch: fetchImpl, env: ENV, budgetMs: 150 });   // 預算 150 ms：第一輪一定跑不完
  const out1 = await run(id, { origin: 'https://site.test' });
  const meta1 = await store.get(metaKey(id), { type: 'json' });
  check('預算到：中止上游、存下目前的 assistant 內容（resume）、呼叫自己接力', out1.chained === true && meta1.status === 'running' && meta1.resume && Array.isArray(meta1.resume.content) && selfCalls.length === 1 && selfCalls[0].id === id && selfCalls[0].resume === true, JSON.stringify({ out1, resume: meta1.resume && meta1.resume.round, selfCalls }));
  const out2 = await run(id, { resume: true, origin: 'https://site.test' });
  const meta2 = await store.get(metaKey(id), { type: 'json' });
  let text = ''; for (let i = 0; i < meta2.chunks; i++) text += await store.get(chunkKey(id, i), { type: 'text' });
  const n0 = (text.match(/event: message_start/g) || []).length;
  check('接力：第二個執行個體帶著前面的內容續寫、完成；瀏覽器只看到一次 message_start，文字接得上', out2.done && meta2.status === 'done' && meta2.invocations === 2 && sent.length === 2 && sent[1].messages[1].role === 'assistant' && n0 === 1 && /結尾<\/article>/.test(text), JSON.stringify({ out2, inv: meta2.invocations, n0, msgs: sent[1] && sent[1].messages.length }));
  // 中途被終止、又不是接力 → 標失敗而不是從頭重跑
  const id2 = newJobId();
  await store.set(promptKey(id2), 'p');
  await store.setJSON(metaKey(id2), { id: id2, status: 'running', createdAt: 'x', updatedAt: new Date(Date.now() - 10 * 60000).toISOString(), model: 'claude-sonnet-5-5', lang: 'zh', chunks: 3, bytes: 100, invocations: 1 });
  const out3 = await run(id2, { origin: 'https://site.test' });
  const meta3 = await store.get(metaKey(id2), { type: 'json' });
  check('心跳停了 10 分鐘的 running 工作被重新叫到：標 failed BG_INTERRUPTED，不從頭重跑', out3.failed === 'interrupted' && meta3.status === 'failed' && meta3.error.code === 'BG_INTERRUPTED' && sent.length === 2, JSON.stringify(meta3.error));
  await store.setJSON(metaKey(id2), { ...meta3, status: 'running', updatedAt: new Date().toISOString() });
  const out4 = await run(id2, { origin: 'https://site.test' });
  check('心跳新鮮的 running 工作被重複叫到：跳過（另一個執行個體在跑）', out4.skipped === 'active', JSON.stringify(out4));
}

// ───────────────────────── 清理 ─────────────────────────
{
  const store = memoryStore();
  const old = newJobId(new Date('2026-11-01T00:00:00Z')), recent = newJobId(new Date('2026-11-10T00:00:00Z'));
  await store.setJSON(metaKey(old), { id: old }); await store.set(chunkKey(old, 0), 'x'); await store.setJSON(metaKey(recent), { id: recent });
  const n = await cleanupOldJobs(store, new Date('2026-11-10T08:00:00Z'));
  const left = (await store.list({ prefix: 'j/' })).blobs.map(b => b.key);
  check('清理：兩天前的工作連同塊一起刪，近期的留著', n === 2 && left.length === 1 && left[0].includes(recent), JSON.stringify({ n, left }));
}

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

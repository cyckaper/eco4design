// 提示快取（2026-11-05 開）：analyze.js 送出去的請求、接續請求、退路，以及前端怎麼算輸入 tokens 與費用
//   node test/prompt-cache.test.mjs
//
// 為什麼有這支測試：2026-11-04 之前 7 天，Sonnet 5.5 的輸入 token 是 8,500 萬、快取命中 0%。
// 伺服器端的搜尋迴圈每搜尋一次、每讀一個網頁就把前面全部的內容重讀一遍；請求裡只要有一個 cache_control，
// API 就會在每一次搜尋結果後面自動設快取點，後面幾輪改按快取價讀。這裡守的是：
//   - 分析（會上網）一定帶快取：提示詞那一塊標 cache_control，頂層也帶（自動快取，接續請求靠它讀到前一輪）
//   - revise／support 一定不帶：各只送一次，帶了只會多付寫入快取的 1.25 倍
//   - pause_turn 接續的請求也帶快取
//   - API 萬一不接受快取參數（400 且訊息提到 cache_control）就拿掉快取重送一次，接續也跟著不帶——不可以讓整份分析失敗
//   - 前端：開了快取之後 input_tokens 只剩沒進快取的那一點，輸入總數與每份費用要把寫入、讀取快取的加回來
//
// 這裡不打真的 API：fetch 換成假的，記下每一次送出的內容，回假的 SSE 串流。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

// ── 假的 Deno 環境與 fetch ──
const ENV = { ANTHROPIC_API_KEY: 'sk-test-not-a-real-key', QI_PASSCODE: 'test-pass' };
globalThis.Deno = { env: { get: k => ENV[k] } };

const sse = events => events.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
const stream = s => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
const okStream = events => new Response(stream(sse(events)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const endTurn = text => [
  { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 20 } },
  { type: 'message_stop' },
];
const pauseTurn = [
  { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 600, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"台北 鳥類"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://example.org/a', title: 'A', encrypted_content: 'xyz' }] } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { input_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 1200, output_tokens: 30 } },
  { type: 'message_stop' },
];

let sent = [];          // 每一次送到 /v1/messages 的請求內容
let replies = [];       // 依序要回的假回應（函式，收到請求內容）
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/v1/models')) {
    return new Response(JSON.stringify({ data: [
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
    ], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/v1/messages')) {
    const body = JSON.parse(init.body);
    sent.push(body);
    const next = replies.shift();
    if (!next) throw new Error('沒有預備的假回應');
    return next(body);
  }
  throw new Error('測試沒有預期的網址：' + u);
};

const { default: handler } = await import('../netlify/edge-functions/analyze.js');
const { priceOf } = await import('../netlify/shared/model-catalog.js');

const call = async body => {
  const res = await handler(new Request('http://localhost/api/analyze', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode: 'test-pass', ...body }),
  }), { ip: '203.0.113.7' });
  const text = await res.text();   // 讀完整個串流，接續請求才會送出
  return { status: res.status, text };
};
const userBlock = b => Array.isArray(b.messages?.[0]?.content) ? b.messages[0].content[0] : null;
const hasCacheAnywhere = b => JSON.stringify(b).includes('cache_control');

// ── 1. 分析：提示詞那一塊標快取點，頂層也帶 ──
{
  sent = []; replies = [() => okStream(endTurn('<article>ok</article>'))];
  const r = await call({ prompt: '分析這個基地的生態共存設計', model: 'claude-sonnet-5-5' });
  const b = sent[0] || {};
  check('分析：回 200', r.status === 200, r.status);
  check('分析：頂層帶 cache_control（自動快取）', b.cache_control && b.cache_control.type === 'ephemeral', JSON.stringify(b.cache_control));
  check('分析：提示詞放在帶 cache_control 的文字區塊', userBlock(b) && userBlock(b).type === 'text' && userBlock(b).text === '分析這個基地的生態共存設計'
    && userBlock(b).cache_control && userBlock(b).cache_control.type === 'ephemeral', JSON.stringify(b.messages));
  check('分析：快取存 5 分鐘（不設 ttl，不多付 1 小時的 2 倍寫入費）', !JSON.stringify(b).includes('"ttl"'), JSON.stringify(b.cache_control));
  check('分析：工具照舊（web_search＋web_fetch）', Array.isArray(b.tools) && b.tools.some(t => t.name === 'web_search') && b.tools.some(t => t.name === 'web_fetch'),
    JSON.stringify(b.tools));
  check('分析：用量照實轉給瀏覽器（含寫入與讀取快取）', /"cache_read_input_tokens":4000/.test(r.text) && /"cache_creation_input_tokens":900/.test(r.text), r.text.slice(-400));
}

// ── 2. revise 與 support：不帶快取 ──
{
  sent = []; replies = [() => okStream(endTurn('<article>改寫</article>'))];
  const r = await call({ mode: 'revise', model: 'claude-sonnet-5-5',
    prompt: '只刪除與更正，不要加新資料。\n<<<REPORT\n<article><h1>報告</h1><p>內容</p></article>\nREPORT>>>' });
  const b = sent[0] || {};
  check('revise：回 200', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('revise：完全不帶 cache_control', sent.length === 1 && !hasCacheAnywhere(b), JSON.stringify(b).slice(0, 300));
  check('revise：提示詞維持字串', typeof b.messages?.[0]?.content === 'string', JSON.stringify(b.messages));
  check('revise：不帶工具', !b.tools, JSON.stringify(b.tools));
}
{
  sent = []; replies = [() => okStream(endTurn('{"verdicts":[]}'))];
  const r = await call({ mode: 'support', prompt: '判斷每一句是否得到摘要支持。\n<<<SOURCES\n[1] 摘要\nSOURCES>>>' });
  const b = sent[0] || {};
  check('support：回 200', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('support：完全不帶 cache_control', sent.length === 1 && !hasCacheAnywhere(b), JSON.stringify(b).slice(0, 300));
}

// ── 3. pause_turn 接續：接續的請求也帶快取，而且送回前一輪的內容 ──
{
  sent = []; replies = [() => okStream(pauseTurn), () => okStream(endTurn('<article>完整</article>'))];
  const r = await call({ prompt: '分析', model: 'claude-sonnet-5-5' });
  const b2 = sent[1] || {};
  check('接續：一共送了兩次', sent.length === 2, sent.length);
  check('接續：頂層帶 cache_control', b2.cache_control && b2.cache_control.type === 'ephemeral', JSON.stringify(b2.cache_control));
  check('接續：提示詞那一塊一樣標快取點', userBlock(b2) && userBlock(b2).cache_control && userBlock(b2).text === '分析', JSON.stringify(b2.messages && b2.messages[0]));
  const asst = b2.messages && b2.messages[1];
  check('接續：送回前一輪的搜尋與結果（快取的前段要一模一樣才讀得到）', asst && asst.role === 'assistant' && Array.isArray(asst.content)
    && asst.content[0].type === 'server_tool_use' && asst.content[0].input && asst.content[0].input.query === '台北 鳥類'
    && asst.content[1].type === 'web_search_tool_result', JSON.stringify(asst));
  check('接續：瀏覽器拿到的用量是兩次相加（讀取快取 1200＋4000）', /"cache_read_input_tokens":5200/.test(r.text), r.text.slice(-500));
  check('接續：串流以 end_turn 收尾', /"stop_reason":"end_turn"/.test(r.text), r.text.slice(-300));
}

// ── 4. 退路：API 不接受快取參數 → 拿掉快取重送一次 ──
{
  sent = [];
  replies = [
    () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'cache_control: Extra inputs are not permitted' } }),
      { status: 400, headers: { 'content-type': 'application/json' } }),
    () => okStream(pauseTurn),
    () => okStream(endTurn('<article>完整</article>')),
  ];
  const r = await call({ prompt: '分析', model: 'claude-sonnet-5-5' });
  check('退路：分析照樣完成（回 200）', r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
  check('退路：重送那一次完全不帶 cache_control', sent.length >= 2 && !hasCacheAnywhere(sent[1]), JSON.stringify(sent[1] || {}).slice(0, 300));
  check('退路：提示詞變回字串', sent[1] && typeof sent[1].messages[0].content === 'string', JSON.stringify(sent[1] && sent[1].messages));
  check('退路：之後的接續也不帶 cache_control', sent.length === 3 && !hasCacheAnywhere(sent[2]), JSON.stringify(sent[2] || {}).slice(0, 300));
}
{
  sent = [];
  replies = [() => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }),
    { status: 400, headers: { 'content-type': 'application/json' } })];
  const r = await call({ prompt: '分析', model: 'claude-sonnet-5-5' });
  check('退路只管快取：其他 400 照原樣回給瀏覽器、不重送', r.status === 400 && sent.length === 1 && /prompt is too long/.test(r.text), `${r.status} ${sent.length} ${r.text}`);
}

// ── 5. 模型目錄：讀快取的倍數 ──
{
  check('目錄：Sonnet 5.5 讀快取 0.05 倍', priceOf('claude-sonnet-5-5').crx === 0.05, JSON.stringify(priceOf('claude-sonnet-5-5')));
  check('目錄：Opus 5.5 讀快取 0.05 倍', priceOf('claude-opus-5-5').crx === 0.05, JSON.stringify(priceOf('claude-opus-5-5')));
  check('目錄：Haiku 4.5 讀快取 0.1 倍', priceOf('claude-haiku-4-5').crx === 0.1, JSON.stringify(priceOf('claude-haiku-4-5')));
  check('目錄：沒列出的新模型用 0.1 倍（寧可估高）', priceOf('claude-sonnet-6').crx === 0.1 && priceOf('claude-sonnet-6').est === true, JSON.stringify(priceOf('claude-sonnet-6')));
  check('目錄：帶日期的版本跟著基本型號', priceOf('claude-sonnet-5-5-20261001').crx === 0.05, JSON.stringify(priceOf('claude-sonnet-5-5-20261001')));
}

// ── 6. 前端：輸入總數與每份費用 ──
// 這兩支在 index.html 的閉包裡：依名稱把原始碼抽出來再測——測的是線上那份程式碼本身
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
function extract(name) {
  const start = html.indexOf(`  function ${name}(`);
  if (start < 0) throw new Error('index.html 裡找不到 ' + name);
  const end = html.indexOf('\n  }\n', start);
  return html.slice(start, end + 4);
}
const sandbox = new Function(`${extract('usageIn')}\n${extract('reportCost')}\nreturn { usageIn, reportCost };`)();
{
  const { usageIn, reportCost } = sandbox;
  check('前端：輸入總數＝沒進快取＋寫入快取＋讀自快取',
    usageIn({ input_tokens: 50, cache_creation_input_tokens: 150000, cache_read_input_tokens: 1450000 }) === 1600050, usageIn({ input_tokens: 50, cache_creation_input_tokens: 150000, cache_read_input_tokens: 1450000 }));
  check('前端：舊的用量（沒有快取欄位）照舊', usageIn({ input_tokens: 1234, output_tokens: 5 }) === 1234, usageIn({ input_tokens: 1234 }));
  check('前端：沒有用量時是 0', usageIn(null) === 0 && usageIn(undefined) === 0, usageIn(null));
  const price = { in: 2, out: 10, crx: 0.05 };
  const old = { n: 2, nu: 2, i: 2000000, o: 40000, s: 20 };
  const oldFormula = ((old.i / old.nu) * price.in + (old.o / old.nu) * price.out) / 1e6 + (old.s / old.n) * 0.01;
  check('前端：開快取之前的紀錄，費用跟原本的算法一模一樣', Math.abs(reportCost(old, price) - oldFormula) < 1e-12, `${reportCost(old, price)} vs ${oldFormula}`);
  // 一份：沒進快取 50、寫入 150,000（1.25 倍）、讀取 1,450,000（0.05 倍）、輸出 20,000、搜尋 10 次
  const st = { n: 1, nu: 1, i: 1600050, cw: 150000, cr: 1450000, o: 20000, s: 10 };
  const want = (50 * 2 + 150000 * 2 * 1.25 + 1450000 * 2 * 0.05 + 20000 * 10) / 1e6 + 10 * 0.01;
  check('前端：開快取之後，寫入 1.25 倍、讀取照模型的倍數', Math.abs(reportCost(st, price) - want) < 1e-12, `${reportCost(st, price)} vs ${want}`);
  check('前端：目錄沒給倍數時讀快取用 0.1 倍', Math.abs(reportCost(st, { in: 2, out: 10 }) - (want + 1450000 * 2 * 0.05 / 1e6)) < 1e-12, reportCost(st, { in: 2, out: 10 }));
  check('前端：結果頁的用量那一行用輸入總數', /輸入 \$\{usageIn\(u\)\}/.test(html), '');
  check('前端：目錄的讀快取倍數有傳下來', /crx: \+m\.price\.crx/.test(html), '');
}

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

// 前端：背景分析工作的完整流程（Playwright）
//   node test/jobs-ui.mjs
// 假的 /api/jobs（建立 + 分段輪詢）、/api/analyze（串流後備）、/api/verify（503）；看報告有沒有出來、歷史有沒有存、
// 重新載入能不能接續、/api/jobs 不在時會不會退回串流、伺服器端失敗會不會給對的說明。
import pw from '/opt/npm-tools/node_modules/playwright/index.js';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;
const check = (name, pass, got) => { results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`); if (!pass) failed++; };

const JOB = '20261110-' + 'a'.repeat(24);
const sse = events => events.map(ev => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join('');
const ARTICLE = '<article><h1>溪頭 生態共存設計分析</h1><p class="meta">23.6730, 120.7950・溪頭・2026 年 11 月 10 日</p><ul class="summary"><li>R1 林冠層最關鍵</li></ul><!--HEALS:MAP--><h2>1 基地判讀</h2><table><thead><tr><th>項目</th><th>內容</th></tr></thead><tbody><tr><td>海拔</td><td>約 1,150 m（林試所，2020）</td></tr></tbody></table><ul class="warn"><li>保育敏感區 → 位於國有林班地（林業署，無日期）</li></ul><h2>2 物種需求表</h2><table><tbody><tr><td>臺灣藍鵲</td></tr></tbody></table><h2>7 參考文獻</h2><ol class="refs"><li>林試所（2020）。溪頭林相調查。https://www.tfri.gov.tw/x</li></ol></article>';
const EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 0, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://www.tfri.gov.tw/x', title: '溪頭林相調查' }] } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ARTICLE.slice(0, 120) } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ARTICLE.slice(120) } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 20 } },
  { type: 'message_stop' },
];
// 三塊：前 5 個事件、中間 3 個、最後 3 個
const CHUNKS = [sse(EVENTS.slice(0, 5)), sse(EVENTS.slice(5, 8)), sse(EVENTS.slice(8))];

// 假伺服器：mode 控制 /api/jobs 的行為
const srv = { mode: 'ok', polls: [], creates: [], analyzeCalls: 0, served: 0 };
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/' || u.pathname === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(path.join(ROOT, 'index.html'))); return; }
  if (u.pathname === '/api/models') return send(200, { models: [], recommended: null });
  if (u.pathname === '/api/ndvi') return send(404, { error: 'no_scenes', zh: '沒有影像' });
  if (u.pathname === '/api/verify') return send(503, { error: 'stub' });
  if (u.pathname === '/api/jobs' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    srv.creates.push(JSON.parse(body));
    if (srv.mode === 'nojobs') return send(404, { error: 'not found' });
    if (srv.mode === 'badpass') return send(401, { error: '通行碼不正確', code: 'PASSCODE_INVALID' });
    // fail 模式：建立成功、輪詢回 failed（上游 529）
    srv.served = 0;
    return send(202, { job: JOB, model: 'claude-sonnet-5-5' });
  }
  const m = u.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const from = +(u.searchParams.get('from') || 0);
    srv.polls.push({ id: m[1], from, wait: u.searchParams.get('wait') });
    if (m[1] !== JOB) return send(404, { error: '找不到這個分析工作', code: 'JOB_NOT_FOUND' });
    if (srv.mode === 'fail') return send(200, { id: JOB, status: 'failed', model: 'claude-sonnet-5-5', from, next: from, total: 0, chunks: [], heartbeatAgeMs: 100, error: { message: 'Overloaded', status: 529 } });
    // 每次輪詢多給一塊（模擬伺服器慢慢產生）
    srv.served = Math.min(CHUNKS.length, Math.max(srv.served, from) + 1);
    const chunks = CHUNKS.slice(from, srv.served);
    const done = srv.served >= CHUNKS.length;
    return send(200, { id: JOB, status: done ? 'done' : 'running', model: 'claude-sonnet-5-5', from, next: from + chunks.length, total: srv.served, chunks, heartbeatAgeMs: 50,
      progress: { searches: 1, fetches: 0, chars: 100 }, ...(done ? { usage: { output_tokens: 20 }, stopReason: 'end_turn' } : {}) });
  }
  if (u.pathname === '/api/analyze' && req.method === 'POST') {
    srv.analyzeCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-model': 'claude-sonnet-5-5' });
    res.end(CHUNKS.join(''));
    return;
  }
  send(503, { error: 'stub ' + u.pathname });
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const LEAF = process.env.LEAFLET_DIR || '/tmp/lf/node_modules';

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-TW' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => {
  const u = r.request().url();
  if (/leaflet@1\.9\.4\/dist\/leaflet\.js/.test(u)) return r.fulfill({ path: path.join(LEAF, 'leaflet/dist/leaflet.js'), contentType: 'application/javascript' });
  if (/leaflet@1\.9\.4\/dist\/leaflet\.css/.test(u)) return r.fulfill({ path: path.join(LEAF, 'leaflet/dist/leaflet.css'), contentType: 'text/css' });
  // leaflet-image 不載入：底圖瓦片被擋，載入了它會一直等瓦片、截圖永遠不回來（正式站有瓦片，不是問題）
  return r.abort();
});
page.on('dialog', d => d.accept());

async function prepare() {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.fill('#passcode', 'test-pass');
  await page.evaluate(() => { window.__qiData.setLocation(23.673, 120.795); window.__qiData.addSpecies('臺灣藍鵲'); });
  await page.waitForTimeout(2200);   // 等 NDVI（404，很快）與 debounce
}

// ── 1. 正常：背景工作 ──
await prepare();
await page.click('#analyzeBtn');
try {
  await page.waitForFunction(() => document.getElementById('resultDisplay').style.display !== 'none', null, { timeout: 30000 });
} catch (e) {
  const st = await page.evaluate(() => ({ err: document.getElementById('resultError').textContent.slice(0, 400), prog: document.getElementById('loadingProgress').textContent, loading: document.getElementById('loadingState').style.display, rec: window.__qiData.loadJobRecord() }));
  console.log('DEBUG state:', JSON.stringify(st), '\nserver:', JSON.stringify({ creates: srv.creates.length, polls: srv.polls, analyze: srv.analyzeCalls }), '\nerrors:', errors.join(' | '));
  throw e;
}
await page.waitForTimeout(600);
const note = await page.evaluate(() => document.getElementById('loadingModeNote').textContent);
const title = await page.locator('#resultTitle').textContent();
const hist = await page.evaluate(() => window.__qiData.historyEntries());
const rec = await page.evaluate(() => window.__qiData.loadJobRecord());
check('建立工作：帶通行碼、模型與提示詞（含物種）', srv.creates.length === 1 && srv.creates[0].passcode === 'test-pass' && /臺灣藍鵲/.test(srv.creates[0].prompt) && srv.creates[0].lang === 'zh', JSON.stringify(srv.creates[0] && { p: srv.creates[0].passcode, l: srv.creates[0].prompt.length }));
check('輪詢從 0 開始、依序接著 next 問、第一次只等 3 秒', srv.polls.length >= 3 && srv.polls[0].from === 0 && srv.polls[0].wait === '3' && srv.polls[1].from === 1 && srv.polls[2].from === 2, JSON.stringify(srv.polls));
check('載入中的說明改為背景模式（鎖屏、切 App 不中斷）', /背景執行/.test(note) && /自動接上/.test(note), note);
check('報告出來了：檢視區標題是報告的 <h1>', title === '溪頭 生態共存設計分析', title);
check('歷史紀錄：同一筆有結果、來源記錄了搜尋到的網址', hist.length === 1 && !!hist[0].htmlResult && hist[0].meta && hist[0].meta.src && hist[0].meta.src[0].u === 'https://www.tfri.gov.tw/x', JSON.stringify(hist[0] && { has: !!hist[0].htmlResult, src: hist[0].meta && hist[0].meta.src }));
check('完成後清掉 localStorage 的工作紀錄', rec === null, JSON.stringify(rec));
check('沒有走串流後備', srv.analyzeCalls === 0, srv.analyzeCalls);
const metaTxt = await page.locator('#resultMeta').textContent();
check('產生資訊：模型、秒數、1 次搜尋、tokens', /claude-sonnet-5-5/.test(metaTxt) && /1 次搜尋/.test(metaTxt) && /輸出 20 tokens/.test(metaTxt), metaTxt);

// ── 2. 重新載入後接續 ──
srv.polls = []; srv.served = 0;
await page.evaluate(() => { localStorage.removeItem('qi-coexistence-history-v1'); window.__qiData.saveJobRecord({ job: '20261110-' + 'a'.repeat(24), startedAt: Date.now() - 60000, lang: 'zh', site: { lat: 23.673, lon: 120.795, name: '溪頭' }, model: 'claude-sonnet-5-5', runTs: null, datasets: null, landscape: null, mapDataUrl: null }); });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('resultDisplay').style.display !== 'none', null, { timeout: 30000 });
await page.waitForTimeout(400);
const title2 = await page.locator('#resultTitle').textContent();
const rec2 = await page.evaluate(() => window.__qiData.loadJobRecord());
const hist2 = await page.evaluate(() => window.__qiData.historyEntries());
check('重新載入：自動接上先前的工作，從第 0 塊重讀、報告出來、紀錄清掉、新增一筆歷史', srv.polls.length >= 3 && srv.polls[0].from === 0 && title2 === '溪頭 生態共存設計分析' && rec2 === null && hist2.length === 1 && !!hist2[0].htmlResult, JSON.stringify({ polls: srv.polls.length, title2, rec2, h: hist2.length }));
const analyzeDisabled = await page.evaluate(() => document.getElementById('analyzeBtn').disabled);
check('接續完成後「開始分析」恢復可按', analyzeDisabled === false, analyzeDisabled);
// 太舊的紀錄不接
await page.evaluate(() => window.__qiData.saveJobRecord({ job: '20261110-' + 'a'.repeat(24), startedAt: Date.now() - 4 * 3600000, lang: 'zh' }));
srv.polls = [];
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(1200);
const rec3 = await page.evaluate(() => window.__qiData.loadJobRecord());
check('超過 3 小時的工作紀錄：不接續、直接清掉', srv.polls.length === 0 && rec3 === null, JSON.stringify({ polls: srv.polls.length, rec3 }));

// ── 3. /api/jobs 不存在 → 退回串流 ──
srv.mode = 'nojobs'; srv.polls = []; srv.creates = []; srv.analyzeCalls = 0;
await prepare();
await page.click('#analyzeBtn');
await page.waitForFunction(() => document.getElementById('resultDisplay').style.display !== 'none', null, { timeout: 30000 });
const note3 = await page.evaluate(() => document.getElementById('loadingModeNote').textContent);
const title3 = await page.locator('#resultTitle').textContent();
check('/api/jobs 回 404：退回串流路徑，報告照樣出來，說明換回「保持前景」', srv.creates.length === 1 && srv.analyzeCalls === 1 && srv.polls.length === 0 && title3 === '溪頭 生態共存設計分析' && /保持本頁在前景/.test(note3), JSON.stringify({ c: srv.creates.length, a: srv.analyzeCalls, note3 }));

// ── 4. 通行碼錯：不退回串流，直接顯示錯誤 ──
srv.mode = 'badpass'; srv.creates = []; srv.analyzeCalls = 0;
await prepare();
await page.click('#analyzeBtn');
await page.waitForFunction(() => document.getElementById('resultError').style.display !== 'none', null, { timeout: 15000 });
const err4 = await page.locator('#resultError').textContent();
check('建立工作被拒（401）：顯示通行碼說明、不打串流', /通行碼不正確/.test(err4) && srv.analyzeCalls === 0, err4.slice(0, 80));

// ── 5. 伺服器端失敗（529）→ 對應的說明 ──
srv.mode = 'fail'; srv.creates = []; srv.polls = [];
await prepare();
await page.click('#analyzeBtn');
await page.waitForFunction(() => document.getElementById('resultError').style.display !== 'none', null, { timeout: 30000 });
const err5 = await page.locator('#resultError').textContent();
const rec5 = await page.evaluate(() => window.__qiData.loadJobRecord());
check('背景工作失敗（上游 529）：顯示 Anthropic 繁忙的說明＋背景分析未能完成，紀錄清掉', /背景分析未能完成/.test(err5) && /529/.test(err5) && rec5 === null, err5.slice(0, 160));

check('沒有頁面錯誤', errors.length === 0, errors.join('\n'));

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

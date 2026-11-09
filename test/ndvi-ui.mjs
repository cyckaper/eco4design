// NDVI 面板的瀏覽器端檢查（不是單元測試，是「這段 DOM 程式真的跑得起來」的驗證）
//   node test/ndvi-ui.mjs
// 需要 playwright 與 chromium（雲端工作區已預裝），以及本機的 Leaflet（同 tbn-ui.mjs：
//   mkdir -p /tmp/lf && cd /tmp/lf && npm i leaflet@1.9.4 leaflet-image@0.4.0；或設 LEAFLET_DIR）。
//
// 假的 /api/ndvi 回應是 test/fixtures/ndvi_sample.json——由 ndvi.test.mjs 用合成的 COG 算出來的真結果
// （NDVI_FIXTURE=1 node test/ndvi.test.mjs 可重新產生），所以表格裡的數字有已知答案可以對。
// 走真正的使用路徑：setLocation → debounceNdvi → fetch → renderNdvi → 小地圖、表格、提示詞、匯出、附錄、語言切換。
const _pw = await import('/opt/npm-tools/node_modules/playwright/index.js');
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

const sample = readFileSync(join(ROOT, 'test', 'fixtures', 'ndvi_sample.json'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'));
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const LEAFLET = process.env.LEAFLET_DIR || '/tmp/lf/node_modules';
const haveLeaflet = existsSync(`${LEAFLET}/leaflet/dist/leaflet.js`);
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+26JNFgAAAABJRU5ErkJggg==', 'base64');
const localFile = {
  'leaflet@1.9.4/dist/leaflet.css': [`${LEAFLET}/leaflet/dist/leaflet.css`, 'text/css'],
  'leaflet@1.9.4/dist/leaflet.js': [`${LEAFLET}/leaflet/dist/leaflet.js`, 'text/javascript'],
  'leaflet-image@0.4.0/leaflet-image.js': [`${LEAFLET}/leaflet-image/leaflet-image.js`, 'text/javascript'],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-TW' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e.message || e)));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_ABORTED/.test(m.text())) errors.push('console: ' + m.text()); });
let ndviCalls = 0;
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('/api/ndvi')) { ndviCalls++; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-ndvi-cache': 'miss' }, body: sample }); }
  if (url.includes('inaturalist.org')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: 0, results: [] }) });
  if (url.includes('/api/osm')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: [] }) });
  if (url.includes('/api/tbn')) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'TBN is unavailable', zh: 'TBN 目前無法連線' }) });
  if (url.includes('/api/models')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) });
  if (url.includes('/api/taxon-status')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: {}, pending: [] }) });
  if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
  for (const [suffix, [file, type]] of Object.entries(localFile)) {
    if (url.includes(suffix)) return haveLeaflet ? route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }) : route.abort();
  }
  if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(url) || /tile/i.test(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
  return route.abort();
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(500);
const D = '__qiData', P = '__qiPrompt', X = '__qiExclusion';

check('初始狀態：提示選擇基地', /請先選擇基地位置/.test(await page.locator('#ndviStatus').textContent()), await page.locator('#ndviStatus').textContent());
await page.evaluate(() => window.__qiData.setLocation(24.7958, 121.5543));
await page.waitForFunction(() => document.getElementById('ndviResults').classList.contains('on'), null, { timeout: 15000 });
await page.waitForTimeout(400);
check('setLocation 之後自動查詢一次', ndviCalls === 1, ndviCalls);
const status = await page.locator('#ndviStatus').textContent();
check('狀態列：景數、期間、圖幅', /完成：5 景/.test(status) && /2025-11-01～2026-11-01/.test(status) && /51RUH/.test(status), status);
const ths = await page.locator('#ndviTable thead th').allTextContents();
check('表格欄：半徑 500 m、1 km、5 km、10 km', ths.join(',') === '半徑,500 m,1 km,5 km,10 km', ths.join(','));
const cell = async (label, i) => (await page.locator('#ndviTable tbody tr', { hasText: label }).first().locator('td').allTextContents())[i];
check('500 m 密植生 5.1%（合成資料：400 像元／7845）', await cell('密植生（≥ 0.5）', 0) === '5.1%', await cell('密植生（≥ 0.5）', 0));
check('1 km 水域 0.3%（100 像元）、500 m 水域 0%', await cell('水域（< 0）', 1) === '0.3%' && await cell('水域（< 0）', 0) === '0%', `${await cell('水域（< 0）', 0)} ${await cell('水域（< 0）', 1)}`);
check('密植生塊區：四個半徑都是 1 個、4.0 ha', await cell('塊區數', 0) === '1' && await cell('塊區數', 3) === '1' && /^4\.0 ·/.test(await cell('最大塊區', 0)), `${await cell('塊區數', 0)} ${await cell('最大塊區', 0)}`);
const scenesTxt = await page.locator('#ndviScenes').textContent();
check('使用影像依日期列出 5 景與雲量', (scenesTxt.match(/（雲 \d+%）/g) || []).length === 5 && scenesTxt.indexOf('2026-01-15') < scenesTxt.indexOf('2026-02-10'), scenesTxt);
check('沒有警示（景數夠、沒有缺值）', await page.locator('#ndviNote').evaluate(e => e.style.display === 'none'), await page.locator('#ndviNote').textContent());
if (haveLeaflet) {
  check('Leaflet 載入成功', await page.evaluate(() => typeof window.L === 'object'), 'window.L 不存在');
  const overlay = await page.locator('#ndviMap .leaflet-image-layer').count();
  const paths = await page.locator('#ndviMap path').count();
  check('小地圖：1 張預覽圖、4 個半徑圈 + 1 個基地點', overlay === 1 && paths === 5, `overlay=${overlay} paths=${paths}`);
} else {
  results.push('SKIP  小地圖（本機沒有 Leaflet：mkdir -p /tmp/lf && cd /tmp/lf && npm i leaflet@1.9.4 leaflet-image@0.4.0）');
}

// 提示詞
const prompt = await page.evaluate(() => window.__qiPrompt.buildPrompt());
const blk = prompt.slice(prompt.indexOf('🛰️'));
check('提示詞有 NDVI 區塊，在基地條件之後、報告結構之前', prompt.indexOf('🛰️') > prompt.indexOf('🌳 基地條件') && prompt.indexOf('🛰️') < prompt.indexOf('📋 報告結構'), prompt.indexOf('🛰️') + ' / ' + prompt.indexOf('📋'));
check('區塊含門檻說明、四個半徑、使用方式與不可寫成森林覆蓋率的提醒', /門檻：水域 NDVI < 0/.test(blk) && /半徑 500 m（78 ha/.test(blk) && /半徑 10 km（31416 ha/.test(blk) && /使用方式：500 m 與 1 km/.test(blk) && /不可寫成「森林覆蓋率」/.test(blk), blk.slice(0, 600));
check('區塊含歐洲太空總署的 APA 參考文獻與 STAC 網址', /歐洲太空總署（無日期）。［Copernicus Sentinel-2 Level-2A/.test(blk) && /earth-search\.aws\.element84\.com\/v1\/search\?collections=sentinel-2-c1-l2a&bbox=/.test(blk), blk.slice(blk.indexOf('歐洲'), blk.indexOf('歐洲') + 300));
check('提示詞裡的 NDVI 數字與面板一致（密植生 5.1%）', /密植生 5\.1%/.test(blk), blk.match(/半徑 500 m[^\n]*/)[0]);

// 資料集紀錄 → 查證認得 → 附錄
const ds = await page.evaluate(() => window.__qiData.captureDatasets());
check('captureDatasets 有 ndvi（座標、期間、景數、圖幅）', ds.ndvi && ds.ndvi.lat === 24.7958 && ds.ndvi.start === '2025-11-01' && ds.ndvi.scenes === 5 && ds.ndvi.grid === 'MGRS-51RUH' && !!ds.ndvi.at, JSON.stringify(ds.ndvi));
const meta = await page.evaluate(() => window.__qiExclusion.compactMeta({ route: 'api', ds: window.__qiData.captureDatasets() }));
check('compactMeta 保留 ds.ndvi', meta.ds && meta.ds.ndvi && meta.ds.ndvi.scenes === 5, JSON.stringify(meta.ds && meta.ds.ndvi));
const keys = await page.evaluate(() => [...window.__qiData.toolDatasetKeys({ ds: window.__qiData.captureDatasets() })]);
const refUrl = (blk.match(/https:\/\/earth-search[^\s［\]]+/) || [])[0];
const normKey = await page.evaluate(u => window.__qiExclusion.normUrlKey(u), refUrl);
check('提示詞裡的參考文獻網址就是 toolDatasetKeys 裡的鍵', !!refUrl && keys.includes(normKey), `${refUrl} → ${normKey} ∉ ${keys.join(' | ')}`);
const appendix = await page.evaluate(() => window.__qiData.buildDataSourcesHtml(document, { ds: window.__qiData.captureDatasets() }, false));
check('附錄資料來源有 Copernicus Sentinel-2 一項（SCL、門檻、授權）', /Copernicus Sentinel-2（ESA）/.test(appendix) && /SCL/.test(appendix) && /Copernicus 資料授權/.test(appendix), appendix.slice(0, 300));
const exp = await page.evaluate(() => window.__qiData.buildHealsExport());
check('匯出給總控台的 JSON 有 landscape（四個半徑、期間、門檻）', exp.landscape && exp.landscape.radii.length === 4 && exp.landscape.period.start === '2025-11-01' && exp.landscape.thresholds.dense === 0.5, JSON.stringify(exp.landscape && Object.keys(exp.landscape)));

// 英文
await page.evaluate(() => window.__qiData.setLang('en'));
await page.waitForTimeout(300);
const enTitle = await page.locator('.ndvi-panel .osm-head-title').textContent();
const enStatus = await page.locator('#ndviStatus').textContent();
const enThs = await page.locator('#ndviTable thead th').allTextContents();
const enOpt = await page.locator('#ndviMonths option').first().textContent();
check('英文：標題、狀態、表頭、選單都切換', /Vegetation & Landscape Structure/.test(enTitle) && /NDVI composite of 5 Sentinel-2 scenes/.test(enStatus) && enThs[0] === 'Radius' && enOpt === 'Last 12 months', `${enTitle} | ${enStatus} | ${enThs[0]} | ${enOpt}`);
const enPrompt = await page.evaluate(() => window.__qiPrompt.buildPrompt());
check('英文提示詞：區塊標題與 European Space Agency 參考文獻', /🛰️ VEGETATION AND LANDSCAPE STRUCTURE/.test(enPrompt) && /European Space Agency\. \(n\.d\.\)\. \[Copernicus Sentinel-2 Level-2A/.test(enPrompt) && /Do not report them as forest cover/.test(enPrompt), enPrompt.slice(enPrompt.indexOf('🛰️'), enPrompt.indexOf('🛰️') + 300));
await page.evaluate(() => window.__qiData.setLang('zh'));
await page.waitForTimeout(200);
check('切回中文：表頭復原', (await page.locator('#ndviTable thead th').allTextContents())[0] === '半徑', 'not restored');

// 換期間 → 重查；同一基地同期間 → 走快取不重查
await page.selectOption('#ndviMonths', '24');
await page.waitForTimeout(600);
check('改期間會重新查詢', ndviCalls === 2, ndviCalls);
await page.selectOption('#ndviMonths', '12');
await page.waitForTimeout(600);
check('切回原期間走前端快取，不再打 API', ndviCalls === 2, ndviCalls);

// 移到遠處的新基地：自動清空並重查
await page.evaluate(() => window.__qiData.setLocation(23.673, 120.795));
await page.waitForTimeout(2600);
check('新基地重新查詢', ndviCalls === 3 && /完成/.test(await page.locator('#ndviStatus').textContent()), `${ndviCalls} ${await page.locator('#ndviStatus').textContent()}`);

// 清空表單
page.on('dialog', d => d.accept());
await page.evaluate(() => window.__qiData.resetForm());
await page.waitForTimeout(200);
check('清空表單：面板回到初始狀態、提示詞沒有 NDVI 區塊', !(await page.locator('#ndviResults').evaluate(e => e.classList.contains('on'))) && !/🛰️/.test(await page.evaluate(() => window.__qiPrompt.buildPrompt())), await page.locator('#ndviStatus').textContent());

// 失敗回應：狀態列顯示中文訊息、不影響其他面板
await page.unroute('**/*');
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('/api/ndvi')) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no_scenes', zh: '這段期間內沒有雲量可用的 Sentinel-2 影像' }) });
  if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
  return route.fulfill({ status: 200, contentType: 'application/json', body: '{"elements":[],"results":[],"models":[],"total_results":0,"groups":[],"species":[]}' });
});
await page.evaluate(() => window.__qiData.setLocation(25.03, 121.56));
await page.waitForFunction(() => /失敗/.test(document.getElementById('ndviStatus').textContent), null, { timeout: 15000 });
check('伺服器回錯誤：狀態列顯示中文原因', /NDVI 分析失敗：這段期間內沒有雲量可用的 Sentinel-2 影像/.test(await page.locator('#ndviStatus').textContent()), await page.locator('#ndviStatus').textContent());
check('沒有頁面錯誤', errors.length === 0, errors.join('\n'));

await browser.close();
server.close();
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

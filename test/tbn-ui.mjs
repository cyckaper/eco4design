// TBN 面板的瀏覽器端檢查（不是單元測試，是「這段 DOM 程式真的跑得起來」的驗證）
//   node test/tbn-ui.mjs
// 需要 playwright 與 chromium（雲端工作區已預裝）。
//
// 為什麼需要這一支：
// renderTbn 有一百多行 DOM 程式，單元測試驗的是 netlify/functions/tbn.mjs 的輸出，
// 碰不到前端。前端若有一個 typo，面板就整塊空白，而其他面板看起來都正常——
// 部署上去才發現太晚。這裡用假的 /api/tbn 回應把它實際跑一遍。

// playwright 裝在工作區的全域目錄，不在這個 repo 的 node_modules 裡
const _pw = await import('/opt/npm-tools/node_modules/playwright/index.js');
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);
import { createServer } from 'node:http';
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

// 欄位形狀照 2026-11-01 從 TBN 實際取得的紀錄（含中英並列的 nativeness、帶 <i> 的學名）
const species = [
  { id: 'u1', sci: 'Dendrocitta formosae', zh: '樹鵲', famSci: 'Corvidae', famZh: '鴉科',
    group: '鳥類', groupCode: 'birds', rank: '種', taicol: 't1', protected: null,
    redlist: 'LC', redlistFull: '暫無危機（LC, Least Concern）', iucn: 'LC',
    endemic: false, nativeness: '原生', estab: '不確定', n: 128, years: [1998, 2024],
    elev: [1100, 1250], blurred: false, uncertainty: 0, sensitive: null },
  { id: 'u2', sci: 'Muntiacus reevesi', zh: '山羌', famSci: 'Cervidae', famZh: '鹿科',
    group: '哺乳類', groupCode: 'mammals', rank: '種', taicol: 't2',
    // 線上實測的真實字串（不是文件所列的「第三級其他應予保育」）
    protected: '其他應予保育之野生動物', redlist: 'LC', redlistFull: '暫無危機（LC, Least Concern）',
    endemic: true, nativeness: '原生', estab: '原生', n: 14, years: [2010, 2023],
    elev: [900, 1400], blurred: true, uncertainty: 5000, sensitive: '敏感' },
  { id: 'u3', sci: 'Bidens pilosa', zh: '大花咸豐草', famSci: 'Asteraceae', famZh: '菊科',
    group: '被子植物', groupCode: 'angiosperms', rank: '種', taicol: 't3', protected: null,
    redlist: null, redlistFull: null, endemic: false, nativeness: '外來歸化',
    estab: '歸化', n: 47, years: [2005, 2024], elev: [800, 1200],
    blurred: false, uncertainty: 10, sensitive: null },
  { id: 'u4', sci: 'Pitta nympha', zh: '八色鳥', famSci: 'Pittidae', famZh: '八色鳥科',
    group: '鳥類', groupCode: 'birds', rank: '種', taicol: 't4',
    // 線上實測的真實字串（不是文件所列的「第二級珍貴稀有」）
    protected: '珍貴稀有保育類野生動物', redlist: 'VU', redlistFull: '易危（VU, Vulnerable）',
    endemic: false, nativeness: '原生', estab: null, n: 3, years: [2019, 2019],
    elev: [1000, 1000], blurred: true, uncertainty: 1000, sensitive: '敏感' },
  // 實測溪頭 3 km 的 619 個分類群裡只有 512 個是種，還有一筆是「真菌界」。
  // 不標階層的話，報告會把整個真菌界當成一個物種寫進去。
  { id: 'u5', sci: 'Fungi', zh: '真菌界', famSci: null, famZh: null,
    group: '真菌類', groupCode: 'fungi', rank: '界', taicol: 't5', protected: null,
    redlist: null, redlistFull: null, endemic: null, nativeness: null, estab: null,
    n: 9, years: [2015, 2020], elev: null, blurred: false, uncertainty: null, sensitive: null },
  { id: 'u6', sci: 'Acraea issoria formosana', zh: '苧麻珍蝶(formosana亞種)',
    famSci: 'Nymphalidae', famZh: '蛺蝶科', group: '蝶類', groupCode: 'butterflies',
    rank: '種下階層', taicol: 't6', protected: null, redlist: null, redlistFull: null,
    endemic: true, nativeness: '原生', estab: '野生', n: 5, years: [2018, 2022],
    elev: [900, 1100], blurred: false, uncertainty: 50, sensitive: null },
];

const payload = {
  source: 'TBN 臺灣生物多樣性網絡',
  sourceUrl: 'https://www.tbn.org.tw/',
  site: { lat: 23.673, lon: 120.795, r: 3 },
  total: 92899,            // 各類群 meta.total 之和
  rangeTotal: 93632,       // 不分類群的真實總筆數（參考文獻的網址是這個查詢）
  ungrouped: 733,
  sample: { perGroup: 100, records: 500, groups: 5, complete: false },
  groups: [
    { code: 'birds', zh: '鳥類', total: 73210, sampled: 100, species: 2, partial: true },
    { code: 'angiosperms', zh: '被子植物', total: 9508, sampled: 100, species: 1, partial: true },
    { code: 'mammals', zh: '哺乳類', total: 394, sampled: 100, species: 1, partial: true },
    { code: 'butterflies', zh: '蝶類', total: 341, sampled: 100, species: 1, partial: true },
    { code: 'fungi', zh: '真菌類', total: 116, sampled: 100, species: 1, partial: true },
  ],
  species,
  datasets: [
    { name: 'eBird Basic Dataset', publisher: 'Cornell Lab', author: 'A', license: 'CC BY', uuid: 'd1', n: 100 },
    { name: '特生中心調查資料', publisher: 'TESRI', author: 'B', license: 'CC BY-NC', uuid: 'd2', n: 50 },
  ],
  licenses: ['CC BY', 'CC BY-NC'],
  notes: [
    '物種清單是取樣結果：每個類群最多取 100 筆紀錄，而這個範圍內共有 93,632 筆。',
    '取的是 TBN 回傳的前幾筆，不是隨機樣本，所以清單可以說明「這些物種在這裡有紀錄」，但不能說明「這裡只有這些物種」，也不能用來判斷哪些最常見。',
    '各類群的總筆數（total）取自 TBN 的 meta.total，那個數字是完整範圍的真實筆數。',
  ],
  cache: 'miss', ms: 4210,
};

// 本機靜態伺服器：file:// 下 fetch 與相對路徑行為不同，用 http 才接近實際情形
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(ROOT, 'index.html')));
  } else {
    res.writeHead(404); res.end('');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
// 介面語言依瀏覽器語系決定；headless 預設 en-US，固定成 zh-TW 才驗到班上實際使用的中文版
const context = await browser.newContext({ locale: 'zh-TW' });
const page = await context.newPage();

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + String(e.message || e)));
page.on('console', m => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/Failed to load resource|ERR_FAILED|ERR_ABORTED/.test(t)) return;   // 被擋掉的外部資源，不是程式錯誤
  errors.push('console: ' + t);
});

// 這個工作區連不出去，所以外部資源在本機供應：
//   Leaflet 用 npm 裝的同一份檔案（unpkg 直接服務 npm 的檔案，SRI 雜湊因此相同，
//   否則 integrity 檢查會失敗、script 根本不執行，整頁都起不來）
//   地圖圖磚回一張 1×1 PNG——擋掉的話 console 會被 ERR_FAILED 淹沒，看不見真正的錯誤
const LEAFLET = '/tmp/lf/node_modules';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+26JNFgAAAABJRU5ErkJggg==',
  'base64');
const localFile = {
  'leaflet@1.9.4/dist/leaflet.css': [`${LEAFLET}/leaflet/dist/leaflet.css`, 'text/css'],
  'leaflet@1.9.4/dist/leaflet.js': [`${LEAFLET}/leaflet/dist/leaflet.js`, 'text/javascript'],
  'leaflet-image@0.4.0/leaflet-image.js': [`${LEAFLET}/leaflet-image/leaflet-image.js`, 'text/javascript'],
};
const unserved = [];
// /api/tbn 目前要回的內容。測試中途可以換掉，驗不同的回應情境。
let servePayload = payload;
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.includes('/api/tbn')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(servePayload) });
  }
  // 其他面板的 API 給空回應：要驗的是 TBN，但它們的 fetch 失敗會把 console 塞滿
  if (url.includes('inaturalist.org')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: 0, results: [] }) });
  }
  if (url.includes('/api/osm')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: [] }) });
  }
  if (url.includes('/api/models')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) });
  }
  if (url.includes('/api/taxon-status')) {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: {}, pending: [] }) });
  }
  if (url.startsWith(`http://127.0.0.1:${port}/`)) return route.continue();
  for (const [suffix, [file, type]] of Object.entries(localFile)) {
    if (url.includes(suffix)) return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) });
  }
  if (/\.(png|jpg|jpeg|webp)(\?|$)/i.test(url) || /tile/i.test(url)) {
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
  }
  unserved.push(url);
  return route.abort();
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(500);

// 走真正的使用路徑：填入座標 → input 事件 → debounceTbn → /api/tbn（假回應）→ renderTbn。
// 比直接呼叫 renderTbn 好，因為連我新接的事件監聽與 debounce 一起驗到了。
check('Leaflet 載入成功（SRI 通過）', await page.evaluate(() => typeof window.L === 'object'), 'window.L 不存在');

await page.evaluate(() => {
  const set = (id, v) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set('lat', 23.673);
  set('lon', 120.795);
});
await page.waitForFunction(() => document.querySelectorAll('.tbn-item').length > 0, { timeout: 8000 })
  .then(() => check('選點後面板自動載入並繪出卡片', true, ''))
  .catch(() => check('選點後面板自動載入並繪出卡片', false,
    'tbn-item 一直沒出現：' + (document.title || '') ));

const dom = await page.evaluate(() => {
  const q = s => document.querySelector(s);
  const items = [...document.querySelectorAll('.tbn-item')];
  return {
    status: (q('#tbnStatus') || {}).textContent || '',
    note: (q('#tbnNote') || {}).textContent || '',
    noteVisible: !!q('#tbnNote') && q('#tbnNote').style.display !== 'none',
    chips: [...document.querySelectorAll('.tbn-chip')].map(c => c.textContent.trim()),
    count: items.length,
    names: items.map(i => (i.querySelector('.tbn-name') || {}).textContent || ''),
    metas: items.map(i => ((i.querySelector('.tbn-name') || {}).textContent || '') + ' ｜ '
      + ((i.querySelector('.tbn-meta') || {}).textContent || '')),
    badges: items.map(i => [...i.querySelectorAll('.tbn-badge')].map(b => b.className.replace('tbn-badge ', '') + ':' + b.textContent)),
    attribution: (q('#tbnAttribution') || {}).textContent || '',
    legendVisible: !!q('#tbnLegend') && q('#tbnLegend').style.display !== 'none',
  };
});

check('六個分類群都繪出卡片', dom.count === 6, dom.count);
check('中文名顯示正確', dom.names.includes('樹鵲') && dom.names.includes('八色鳥'), JSON.stringify(dom.names));
check('統計列出現原生與外來數量', /原生 4/.test(dom.status) && /外來 1/.test(dom.status), dom.status);
// 顯示的是 rangeTotal（與參考文獻網址一致），不是類群總和
check('統計列用範圍總筆數 93,632（不是類群總和 92,899）',
  /93,632/.test(dom.status) && !/92,899/.test(dom.status), dom.status);
// 六個分類群裡只有四個鑑定到種
check('統計列說明幾個鑑定到種', /4 個鑑定到種/.test(dom.status), dom.status);

// 最要緊的：取樣說明要看得見
check('取樣說明有顯示', dom.noteVisible, dom.noteVisible);
check('取樣說明寫明「取樣」', /取樣/.test(dom.note), dom.note.slice(0, 80));
check('取樣說明寫明不能當完整名錄', /不能說明/.test(dom.note), dom.note.slice(0, 160));

const flat = dom.badges.flat().join(' | ');
check('原生標籤', /native:原生/.test(flat), flat);
check('外來標籤（外來歸化）', /alien:外來歸化/.test(flat), flat);
check('特有標籤', /endemic:特有/.test(flat), flat);
// 這是線上實測才抓到的 bug：TBN 回的是「珍貴稀有保育類野生動物」，
// 原本的 /^第([一二三])級/ 永遠不命中，整串長字會塞爆卡片。
check('保育標籤（珍貴稀有保育類野生動物 → 保育二）', /protected:保育二/.test(flat), flat);
check('保育標籤（其他應予保育之野生動物 → 保育三）', /protected:保育三/.test(flat), flat);
check('保育標籤不是未縮寫的長字串', !/保育類野生動物/.test(flat), flat);
check('紅皮書受脅等級有標（VU → 易危）', /redlist:易危/.test(flat), flat);
check('暫無危機（LC）不標成標籤', !/redlist:暫無危機|redlist:LC/.test(flat), flat);
check('位置模糊標籤', /blurred:位置模糊/.test(flat), flat);

check('類群篩選鈕有出現（全部＋五類群）', dom.chips.length === 6, JSON.stringify(dom.chips));
// 非種層級要標出來，否則「真菌界」會被當成一個物種
check('界層級的卡片標了「界」', /界/.test(dom.metas.find(m => /真菌界/.test(m)) || ''),
  JSON.stringify(dom.metas));
check('種下階層的卡片標了「亞種／變種」',
  /亞種／變種/.test(dom.metas.find(m => /苧麻珍蝶/.test(m)) || ''), JSON.stringify(dom.metas));
check('種層級的卡片不加階層標示', !/種$/.test((dom.metas.find(m => /樹鵲/.test(m)) || '').trim()),
  JSON.stringify(dom.metas.find(m => /樹鵲/.test(m))));
check('出處含 TBN 與 OGDL', /TBN/.test(dom.attribution) && /OGDL/.test(dom.attribution), dom.attribution);
check('出處含資料集數量', /2 個資料集/.test(dom.attribution), dom.attribution);
check('圖例有顯示', dom.legendVisible, dom.legendVisible);

// 類群篩選
const filtered = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('.tbn-chip')].find(c => /鳥類/.test(c.textContent));
  if (!chip) return { err: '找不到鳥類篩選鈕' };
  chip.click();
  return { count: document.querySelectorAll('.tbn-item').length,
           names: [...document.querySelectorAll('.tbn-name')].map(n => n.textContent) };
});
check('點選鳥類後只顯示鳥類（2 筆）', filtered.count === 2, JSON.stringify(filtered));

// 加入焦點物種。state 在閉包裡讀不到，所以看 DOM 的結果：
// 已選物種的 chip 出現、卡片被標記、提示詞含該物種。
const added = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.tbn-add')].find(b => b.dataset.name === '樹鵲');
  if (!btn) return { err: '找不到樹鵲的加入鈕' };
  btn.click();
  return {
    chip: /樹鵲/.test(document.getElementById('speciesChips')?.textContent || ''),
    marked: !!btn.closest('.tbn-item').classList.contains('added'),
  };
});
check('＋ 把物種加進「已選物種」', added.chip === true, JSON.stringify(added));
check('加入後卡片標記為已加入', added.marked === true, JSON.stringify(added));

// 提示詞脈絡
const prompt = await page.evaluate(() => {
  const el = document.getElementById('promptPreview');
  return el ? el.textContent : '';
});
check('提示詞含 TBN 段落', /TBN 物種紀錄/.test(prompt), prompt.slice(0, 120));
check('提示詞帶出取樣警告', /這是取樣清單，不是完整名錄/.test(prompt), /取樣/.test(prompt) ? '有取樣字樣但措辭不符' : '完全沒有');
check('提示詞禁止把分類群數當物種豐富度', /物種豐富度/.test(prompt), '未出現');
check('提示詞說明幾個鑑定到種、其餘不可當物種',
  /4 個鑑定到種/.test(prompt) && /不可當成物種寫進報告/.test(prompt), '未出現');
check('提示詞標出非種層級的分類群', /界層級|亞種／變種層級/.test(prompt), '未出現');
check('提示詞含保育類清單', /八色鳥/.test(prompt) && /保育：珍貴稀有保育類野生動物/.test(prompt), '未出現');
check('提示詞含外來種清單', /大花咸豐草/.test(prompt) && /外來歸化/.test(prompt), '未出現');
check('提示詞含各類群真實筆數', /鳥類 73,210/.test(prompt), '未出現');
check('提示詞含 APA 參考文獻', /臺灣生物多樣性網絡（無日期）/.test(prompt), '未出現');
check('參考文獻說明清單是取樣而來', /筆出現紀錄之取樣/.test(prompt), '未出現');

// 類群範圍選單：預設 12 類，可改全部 21 類；選單值要進到 /api/tbn 的請求裡
{
  const sent = await page.evaluate(async () => {
    const seen = [];
    const real = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes('/api/tbn')) { try { seen.push(JSON.parse(o.body)); } catch (_) {} }
      return real(u, o);
    };
    const sel = document.getElementById('tbnScope');
    const before = sel ? sel.value : '(沒有這個選單)';
    if (sel) { sel.value = 'all'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 1200));
    window.fetch = real;
    return { before, bodies: seen };
  });
  check('類群範圍預設是 12 類（空字串）', sent.before === '', sent.before);
  check("選「全部 21 類」會把 groups:'all' 送進請求",
    sent.bodies.some(b => b && b.groups === 'all'), JSON.stringify(sent.bodies));
}

// 「有類群沒回應」的警告不能因為取樣完整就被吞掉。
// renderTbn 在閉包裡叫不到，所以換掉 /api/tbn 的回應再按「查詢」，走真正的路徑。
{
  const partial = JSON.parse(JSON.stringify(payload));
  partial.sample.complete = true;                      // 取樣是完整的
  partial.failed = [{ group: 'mammals', zh: '哺乳類', error: 'timeout' }];
  partial.notes = ['有 1 個類群沒有回應（哺乳類），清單裡不會有這些類群的物種——不是那裡沒有，而是這次沒查到。'];
  servePayload = partial;                              // 路由改回傳這一份
  await page.evaluate(() => document.getElementById('tbnRefresh').click());
  await page.waitForFunction(
    () => /哺乳類/.test(document.getElementById('tbnNote')?.textContent || ''), { timeout: 8000 })
    .then(() => check('取樣完整但有類群失敗時，警告仍然顯示並指名類群', true, ''))
    .catch(async () => {
      const el = await page.evaluate(() => {
        const n = document.getElementById('tbnNote');
        return { text: n ? n.textContent : '(沒有元素)', display: n ? n.style.display : '-' };
      });
      check('取樣完整但有類群失敗時，警告仍然顯示並指名類群', false, JSON.stringify(el));
    });
  check('此時不會誤稱為「取樣清單」',
    !/取樣清單/.test(await page.evaluate(() => document.getElementById('tbnNote').textContent)),
    await page.evaluate(() => document.getElementById('tbnNote').textContent.slice(0, 60)));
  servePayload = payload;                              // 還原，不影響後面的檢查
}

// 英文介面也要能繪（標籤、統計列都有英文分支）
const enFlat = await page.evaluate(async () => {
  const btn = document.getElementById('langEn');
  if (btn) { btn.click(); await new Promise(r => setTimeout(r, 300)); }
  return [...document.querySelectorAll('.tbn-badge')].map(b => b.textContent).join(' ');
});
if (enFlat) check('英文介面的標籤是英文', /Native|Introduced|Endemic|Protected/.test(enFlat), enFlat.slice(0, 80));

check('頁面沒有 JavaScript 錯誤', errors.length === 0, errors.slice(0, 4).join('\n        '));
if (unserved.length) console.log('\n（未供應的外部請求，僅供參考）\n  ' + [...new Set(unserved)].slice(0, 6).join('\n  '));

await browser.close();
server.close();

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

// 本工具提供給模型的資料集（iNaturalist／OSM／TBN）在查證時要被認出來
//   node test/tool-datasets.test.mjs
//
// 為什麼有這支測試（2026-11-02 線上實際發生）：
// v1.38 加入 TBN 時，只有提示詞會附 TBN 的參考文獻，查證流程卻只認 iNaturalist 與 OSM。
// 結果是：compactMeta 把 meta.ds.tbn 丟掉 → TBN 不被當成本工具的資料集 →
// 查證去開它的 API 網址、得到 403 → 判為「無法確認存在」→ 刪掉這筆文獻，
// **連同所有引用它的句子與表格列**。實測景興公園那份報告，物種需求表的物種名欄整欄消失。
// 同一處還有一個更早的錯：compactMeta 也丟掉了 iNaturalist 的物種名單（names），
// 剖面圖本該保留「出現在本工具名單中」的物種，實際上名單永遠是空的。
//
// 這些函式都在 index.html 的閉包裡，這裡依名稱把原始碼抽出來組成沙盒再測——
// 測的是線上那份程式碼本身，不是另寫一份。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

// 依名稱抽出 function 或 const 的原始碼
function extract(name) {
  let start = html.indexOf(`  function ${name}(`);
  if (start >= 0) return html.slice(start, html.indexOf('\n  }\n', start) + 4);
  start = html.indexOf(`  const ${name} =`);
  if (start < 0) throw new Error(`index.html 裡找不到 ${name}`);
  return html.slice(start, html.indexOf(';\n', start) + 2);
}
const NAMES = ['trimUnbalanced', 'cleanUrl', 'TRACKING_PARAM_RE', 'normUrlKey', 'safeHref', 'hostOf', 'numIn', 'isoOrNull',
  'inatWebUrl', 'osmWebUrl', 'tbnApiUrl', 'EN_MONTHS', 'datasetRefText', 'compactMeta',
  'toolDatasetKeys', 'TOOL_DATASET_AUTHOR', 'toolDatasetHost', 'toolDataset'];
const src = NAMES.map(extract).join('\n') + `\nreturn { ${NAMES.join(', ')} };`;
const F = new Function(src)();

// captureDatasets 產生的樣子（提示詞與查證用的都是這份）
const lat = 24.9959, lon = 121.5479;
const raw = {
  route: 'api',
  ds: {
    inat: { lat, lon, radius: 2, quality: 'research', taxon: '', species: 15, at: '2026-11-02T00:10:00.000Z',
      names: ['赤腹松鼠', 'Callosciurus erythraeus', '拉都希氏赤蛙', 'Hylarana latouchii'] },
    osm: { lat, lon, radius: 2, total: 2417, at: '2026-11-02T00:10:00.000Z' },
    tbn: { lat, lon, radius: 3, total: 445698, taxa: 389, atSpecies: 316, perGroup: 100, complete: false,
      at: '2026-11-02T00:10:00.000Z', names: ['八哥', 'Acridotheres cristatellus', '無霸勾蜓'] },
  },
};
const meta = F.compactMeta(raw);

// ── 1. compactMeta 要保留 TBN 與物種名單 ─────────────────────────────────
check('compactMeta 保留 ds.tbn', !!(meta.ds && meta.ds.tbn), JSON.stringify(meta.ds && Object.keys(meta.ds)));
check('ds.tbn 的座標與半徑完整', meta.ds.tbn && meta.ds.tbn.lat === lat && meta.ds.tbn.radius === 3,
  JSON.stringify(meta.ds.tbn));
check('ds.tbn 的擷取時間保留（ISO 字串）', meta.ds.tbn && meta.ds.tbn.at === '2026-11-02T00:10:00.000Z',
  meta.ds.tbn && meta.ds.tbn.at);
check('ds.tbn 的取樣資訊保留（perGroup、complete）', meta.ds.tbn && meta.ds.tbn.perGroup === 100 && meta.ds.tbn.complete === false,
  JSON.stringify(meta.ds.tbn));
check('iNaturalist 的物種名單（names）保留——剖面圖靠它', (meta.ds.inat.names || []).includes('赤腹松鼠'),
  JSON.stringify(meta.ds.inat.names));
check('TBN 的物種名單保留', (meta.ds.tbn.names || []).includes('八哥'), JSON.stringify(meta.ds.tbn.names));
check('數字型擷取時間被丟掉而非亂存（isoOrNull 只收字串）',
  F.compactMeta({ ds: { tbn: { lat, lon, radius: 3, at: 1730505600000 } } }).ds.tbn.at === null, 'kept a number');
check('座標不合理時不保留 ds.tbn', !F.compactMeta({ ds: { tbn: { lat: 999, lon, radius: 3 } } }).ds.tbn, 'kept');
check('名單有上限、只收字串', F.compactMeta({ ds: { inat: { lat, lon, radius: 1,
  names: [...Array(200)].map((_, i) => 'x' + i).concat([123, null, {}]) } } }).ds.inat.names.length === 60, 'no cap');

// ── 2. 模型照抄的 TBN 參考文獻，網址要落在本工具資料集的鍵裡 ─────────────
const keys = F.toolDatasetKeys(meta);
const urlOf = s => (s.match(/https?:\/\/[^\s［\]]+/) || [])[0];
for (const en of [false, true]) {
  const ref = F.datasetRefText('tbn', meta.ds.tbn, en);
  const u = urlOf(ref);
  check(`${en ? '英文' : '中文'} TBN 參考文獻裡有網址`, !!u, ref);
  check(`${en ? '英文' : '中文'} TBN 參考文獻的網址被認成本工具資料集`, !!u && keys.has(F.normUrlKey(u)),
    `${u} → ${F.normUrlKey(u)} ∉ ${[...keys].join(' | ')}`);
}
// iNaturalist／OSM 原本就認得，不能因為這次修改壞掉
for (const kind of ['inat', 'osm']) {
  const u = urlOf(F.datasetRefText(kind, meta.ds[kind], false));
  check(`${kind} 參考文獻仍被認成本工具資料集`, !!u && keys.has(F.normUrlKey(u)), u);
}

// ── 3. 作者欄的比對 ──────────────────────────────────────────────────────
for (const [a, want] of [
  ['臺灣生物多樣性網絡（無日期）', true], ['Taiwan Biodiversity Network. (n.d.)', true],
  ['iNaturalist（無日期）', true], ['OpenStreetMap 貢獻者（無日期）', true], ['OpenStreetMap contributors. (n.d.)', true],
  ['臺灣生命大百科（無日期）', false], ['林業及自然保育署（無日期）', false], ['iNaturalistic Society (2020)', false],
]) {
  check(`作者「${a}」${want ? '是' : '不是'}本工具資料集`, F.TOOL_DATASET_AUTHOR.test(a) === want, String(!want));
}

// ── 4. 主機比對：只有這份報告確實附了該資料時才算 ───────────────────────
check('附了 TBN 時，tbn.org.tw 算本工具資料集', F.toolDatasetHost(meta.ds, F.hostOf('https://www.tbn.org.tw/api/v26/occurrence?x=1')),
  'not recognised');
check('沒附 TBN 時，tbn.org.tw 不算', !F.toolDatasetHost({ inat: meta.ds.inat }, F.hostOf('https://www.tbn.org.tw/')), 'recognised');
check('冒牌網域（eviltbn.org.tw）不算', !F.toolDatasetHost(meta.ds, F.hostOf('https://eviltbn.org.tw/')), 'recognised');
check('相似網域（tbn.org.tw.evil.com）不算', !F.toolDatasetHost(meta.ds, F.hostOf('https://tbn.org.tw.evil.com/')), 'recognised');
check('toolDataset 認得 TBN 參考文獻',
  F.toolDataset({ allUrls: [urlOf(F.datasetRefText('tbn', meta.ds.tbn, false))] }, meta), 'false');
check('toolDataset 不把一般網站當成本工具資料集',
  !F.toolDataset({ allUrls: ['https://taieol.tw/pages/1234'] }, meta), 'true');

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

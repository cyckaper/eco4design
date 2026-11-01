// TBN 物種查詢（netlify/functions/tbn.mjs）
//   node test/tbn.test.mjs
// 不需要網路：上游以 globalThis.fetch 的替身供應。
//
// 為什麼這些測試存在：
//   1. circle 參數是「經度 緯度,半徑」——經緯度寫反不會報錯，只會安靜地回傳
//      另一個地方的資料（或零筆）。這種錯誤在畫面上看起來完全正常，必須用測試釘住。
//   2. 物種清單必然是取樣。「這是取樣」這句話必須跟著資料一起回傳，
//      因為看報告的人看不到原始碼與文件。少了它，清單會被當成完整名錄讀。
//   3. 以 taxonUUID 去重。改用學名字串的話，同一物種帶不帶命名者會變成兩筆。
//   4. 這個端點代為連線上游，所以來源限制與速率限制要有測試。

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

const mod = await import(pathToFileURL(join(ROOT, 'netlify', 'functions', 'tbn.mjs')).href);
const { default: handler, aggregate, zhPart, statusCode, clean, originRejected } = mod;

// ── 1. 欄位整理：TBN 的值有幾個固定怪癖 ──────────────────────────────────
{
  check('nativeness 去掉英文（原生 Native → 原生）', zhPart('原生 Native') === '原生', zhPart('原生 Native'));
  check('外來歸化 Naturalized → 外來歸化', zhPart('外來歸化 Naturalized') === '外來歸化', zhPart('外來歸化 Naturalized'));
  check('純中文不受影響', zhPart('不確定') === '不確定', zhPart('不確定'));
  check('純英文保留原樣', zhPart('Native') === 'Native', zhPart('Native'));
  check('null 回 null', zhPart(null) === null, zhPart(null));

  check('紅皮書代碼抽得出來（LC）', statusCode('暫無危機（LC, Least Concern）') === 'LC',
    statusCode('暫無危機（LC, Least Concern）'));
  check('半角括號也可以', statusCode('Endangered (EN)') === 'EN', statusCode('Endangered (EN)'));
  check('沒有代碼時回 null', statusCode('不適用') === null, statusCode('不適用'));
  check('null 回 null', statusCode(null) === null, statusCode(null));

  // scientificName 帶 <i> 標籤；這些字串會進到報告裡
  check('HTML 標籤被清掉', clean('<i>Dendrocitta formosae</i>') === 'Dendrocitta formosae',
    clean('<i>Dendrocitta formosae</i>'));
  check('控制字元被清掉', clean('abc\u0000\u001fdef') === 'abc def', JSON.stringify(clean('abc\u0000\u001fdef')));
  check('長度有上限', clean('x'.repeat(500), 20).length === 20, clean('x'.repeat(500), 20).length);
  check('空字串回 null', clean('   ') === null, clean('   '));
}

// ── 2. 來源限制 ───────────────────────────────────────────────────────────
{
  check('自家子網域放行', originRejected('https://eco4design.healsdesign.org') === null,
    originRejected('https://eco4design.healsdesign.org'));
  check('分支部署放行', originRejected('https://main--cycling-roadbook.netlify.app') === null,
    originRejected('https://main--cycling-roadbook.netlify.app'));
  check('冒牌網域被擋（xxcycling-roadbook）',
    originRejected('https://xxcycling-roadbook.netlify.app') === 'xxcycling-roadbook.netlify.app',
    originRejected('https://xxcycling-roadbook.netlify.app'));
  check('陌生來源被擋', originRejected('https://evil.example.com') === 'evil.example.com',
    originRejected('https://evil.example.com'));
  check('沒有 Origin 放行（伺服器端呼叫）', originRejected(null) === null, originRejected(null));
  check('相似但不同的網域被擋（healsdesign.org.evil.com）',
    originRejected('https://healsdesign.org.evil.com') === 'healsdesign.org.evil.com',
    originRejected('https://healsdesign.org.evil.com'));
}

// ── 3. 彙整：去重、年代、模糊化、出處 ────────────────────────────────────
const rec = (over = {}) => ({
  taxonUUID: 'uuid-tree-magpie', simplifiedScientificName: 'Dendrocitta formosae',
  scientificName: '<i>Dendrocitta formosae</i>', vernacularName: '樹鵲',
  familyScientificName: 'Corvidae', familyVernacularName: '鴉科', taxonGroup: '鳥類',
  taxonRank: '種', taiCOLTaxonID: 'tc-123', protectedStatusTW: null,
  categoryRedlistTW: '暫無危機（LC, Least Concern）', categoryIUCN: '暫無危機（LC, Least Concern）',
  endemism: '非臺灣特有', nativeness: '原生 Native', degreeOfEstablishment: '不確定',
  year: 2016, minimumElevationInMeters: '1149', dataGeneralizations: false,
  coordinateUncertaintyInMeters: 0, dataSensitiveCategory: '無',
  datasetName: 'eBird Basic Dataset', datasetPublisher: 'Cornell Lab', datasetAuthor: 'A. Author',
  datasetUUID: 'ds-ebird', license: 'CC BY', ...over,
});

{
  const agg = aggregate([{
    group: 'birds', total: 73210,
    rows: [
      rec({ year: 1998, minimumElevationInMeters: '1100' }),
      rec({ year: 2024, minimumElevationInMeters: '1250' }),
      // 同一物種、學名帶命名者：以 taxonUUID 為鍵才不會變成兩筆
      rec({ simplifiedScientificName: 'Dendrocitta formosae Swinhoe, 1863', year: 2010 }),
      rec({ taxonUUID: 'uuid-muntjac', simplifiedScientificName: 'Muntiacus reevesi',
            vernacularName: '山羌', taxonGroup: '哺乳類', endemism: '臺灣特有',
            protectedStatusTW: '第三級其他應予保育 Other Conservation-deserving',
            nativeness: '原生 Native', year: 2020, dataGeneralizations: true,
            coordinateUncertaintyInMeters: 5000, dataSensitiveCategory: '敏感',
            datasetName: '特生中心調查', datasetUUID: 'ds-tesri', license: 'CC BY-NC' }),
    ],
  }], 100);

  check('同一物種的三筆併成一筆', agg.species.length === 2, agg.species.length);
  const magpie = agg.species.find(s => s.id === 'uuid-tree-magpie');
  check('紀錄數累加（3）', magpie && magpie.n === 3, magpie && magpie.n);
  check('年代範圍取最小與最大（1998–2024）',
    magpie && magpie.years[0] === 1998 && magpie.years[1] === 2024, JSON.stringify(magpie && magpie.years));
  check('海拔是字串也能算範圍（1100–1250）',
    magpie && magpie.elev[0] === 1100 && magpie.elev[1] === 1250, JSON.stringify(magpie && magpie.elev));
  check('學名用 simplified（沒有 <i> 標籤）',
    magpie && magpie.sci === 'Dendrocitta formosae', magpie && magpie.sci);
  check('非特有 → endemic false', magpie && magpie.endemic === false, magpie && magpie.endemic);
  check('紅皮書代碼 LC', magpie && magpie.redlist === 'LC', magpie && magpie.redlist);
  check('nativeness 去英文', magpie && magpie.nativeness === '原生', magpie && magpie.nativeness);

  const muntjac = agg.species.find(s => s.id === 'uuid-muntjac');
  check('臺灣特有 → endemic true', muntjac && muntjac.endemic === true, muntjac && muntjac.endemic);
  check('保育等級去英文', muntjac && muntjac.protected === '第三級其他應予保育',
    muntjac && muntjac.protected);
  check('模糊化標示保留（blurred）', muntjac && muntjac.blurred === true, muntjac && muntjac.blurred);
  check('座標不確定度保留（5000 m）', muntjac && muntjac.uncertainty === 5000, muntjac && muntjac.uncertainty);
  check('敏感類別保留', muntjac && muntjac.sensitive === '敏感', muntjac && muntjac.sensitive);
  check('「無」不算敏感', magpie && magpie.sensitive === null, magpie && magpie.sensitive);

  check('出處按筆數收集（兩個資料集）', agg.datasets.length === 2, agg.datasets.length);
  check('出處筆數正確（eBird 3 筆）',
    (agg.datasets.find(d => d.uuid === 'ds-ebird') || {}).n === 3,
    JSON.stringify(agg.datasets.map(d => [d.uuid, d.n])));
  check('授權條款收齊（CC BY、CC BY-NC）',
    agg.licenses.join(',') === 'CC BY,CC BY-NC', agg.licenses.join(','));

  check('類群筆數用 meta.total（73210）', agg.groups[0].total === 73210, agg.groups[0].total);
  check('取樣數與總筆數不同時標記 partial', agg.groups[0].partial === true, agg.groups[0].partial);
}

// ── 4. 失敗的類群不會讓整份結果消失 ─────────────────────────────────────
{
  // total 與收到的筆數一致：這個類群的紀錄全部拿到了
  const agg = aggregate([
    { group: 'birds', total: 1, rows: [rec()] },
    { group: 'fishes', error: 'timeout' },
  ], 100);
  check('一個類群逾時，其他類群的資料仍在', agg.species.length === 1, agg.species.length);
  check('失敗的類群被記下來', agg.failed.length === 1 && agg.failed[0].group === 'fishes',
    JSON.stringify(agg.failed));
  check('失敗的類群不進 groups 清單', agg.groups.length === 1, agg.groups.length);
  check('收到的筆數就是全部時不標 partial', agg.groups[0].partial === false, agg.groups[0].partial);
}

// ── 5. 端點：參數、來源、方法 ────────────────────────────────────────────
const realFetch = globalThis.fetch;
const calls = [];
function stubFetch(responder) {
  calls.length = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return responder(String(url));
  };
}
const okJson = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

// 真實的 API 會回 min(total, limit) 筆，替身也必須這樣——
// 否則「total 比收到的筆數多」會在測試裡恆為真，partial 的判斷就測不到了。
const okRows = (total, limit = 100, make = rec) => okJson({
  meta: { total },
  data: Array.from({ length: Math.min(total, limit) }, (_, i) => make(i)),
});

const call = (params, headers, method = 'POST') => {
  const base = 'https://eco4design.healsdesign.org/api/tbn';
  if (method === 'GET') {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return handler(new Request(u, { method: 'GET', headers: headers || {} }), {});
  }
  return handler(new Request(base, { method, headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(params) }), {});
};
const bodyOf = async r => { try { return JSON.parse(await r.text()); } catch (_) { return null; } };

// 快取是模組層級的，跨測試區塊存活：任何兩個案例只要 (lat, lon, r, limit, groups) 相同
// 就會互撞，後面的案例讀到前面的答案，而不是真的執行一次查詢。
// （這個坑踩過兩次：第 8 區塊讀到第 6 區塊的結果，第 11 區塊的 POST 讀到 GET 的結果。）
// 所以每個案例都取一組沒用過的座標；快取鍵取到小數四位，每次 +0.001 就足以分開。
let siteSeq = 0;
const freshSite = (over = {}) => ({ lat: 23.5 + (siteSeq++) * 0.001, lon: 120.5, r: 3, ...over });

{
  stubFetch(() => okJson({ meta: { total: 1 }, data: [rec()] }));

  let r = await handler(new Request('https://eco4design.healsdesign.org/api/tbn', { method: 'DELETE' }), {});
  check('DELETE 回 405', r.status === 405, r.status);

  r = await call({ lat: 23.673, lon: 120.795, r: 3 }, { origin: 'https://evil.example.com' });
  check('陌生來源回 403', r.status === 403, r.status);

  for (const [label, p] of [
    ['缺少座標', { r: 3 }],
    ['緯度超範圍', { lat: 100, lon: 120, r: 3 }],
    ['經度超範圍', { lat: 23, lon: 200, r: 3 }],
    ['半徑 0', { lat: 23, lon: 120, r: 0 }],
    ['半徑 51（TBN 上限 50）', { lat: 23, lon: 120, r: 51 }],
    ['limit 超過 1000', { lat: 23, lon: 120, r: 3, limit: 1001 }],
  ]) {
    const res = await call(p);
    check(`參數檢查擋下「${label}」`, res.status === 400, res.status);
  }

  r = await call({ lat: 23, lon: 120, r: 3, groups: 'birds,unicorns' });
  const b = await bodyOf(r);
  check('未知類群代碼回 400 並列出可用代碼',
    r.status === 400 && Array.isArray(b.known) && b.known.includes('birds'),
    r.status + ' ' + JSON.stringify(b && b.error));
}

// ── 6. circle 參數：經度在前、緯度在後 ───────────────────────────────────
// 寫反的話不會報錯，只會安靜地回別的地方的資料——所以釘住確切的網址。
{
  stubFetch(() => okRows(5));
  // 這個案例要比對確切的網址，所以座標寫死；其餘案例用 freshSite()
  await call({ lat: 23.6731, lon: 120.7951, r: 3, groups: 'birds' });
  check('只查了一個類群（birds）', calls.length === 1, calls.length);
  const u = new URL(calls[0].url);
  check('circle 是「經度 緯度,半徑」', u.searchParams.get('circle') === '120.7951 23.6731,3',
    u.searchParams.get('circle'));
  check('taxonGroup 傳的是英文代碼', u.searchParams.get('taxonGroup') === 'birds',
    u.searchParams.get('taxonGroup'));
  check('limit 預設 100', u.searchParams.get('limit') === '100', u.searchParams.get('limit'));
  check('送出可識別的 User-Agent（OSM 使用規範同樣的禮貌）',
    /Qi-Coexistence-TBN/.test((calls[0].opts.headers || {})['user-agent'] || ''),
    JSON.stringify(calls[0].opts.headers));
}

// ── 7. 預設查全部 21 個類群 ──────────────────────────────────────────────
// 實測溪頭 3 km 內鳥類佔 78 %：不分類群抓一千筆的話，植物與兩棲幾乎看不到。
{
  stubFetch(url => {
    const g = new URL(url).searchParams.get('taxonGroup');
    const total = g === 'birds' ? 73210 : 300;
    return okJson({ meta: { total },
      data: Array.from({ length: Math.min(total, 100) }, () => rec({ taxonUUID: 'u-' + g, taxonGroup: g })) });
  });
  const r = await call(freshSite());
  const b = await bodyOf(r);
  check('預設查 21 個類群', calls.length === 21, calls.length);
  check('每個類群各一筆物種 → 21 個物種', b.species.length === 21, b.species.length);
  check('total 是各類群 meta.total 之和', b.total === 73210 + 300 * 20, b.total);
  check('類群按總筆數排序，鳥類在最前', b.groups[0].code === 'birds', b.groups[0].code);
}

// ── 8. 最要緊的性質：取樣這件事必須跟著資料一起回傳 ─────────────────────
{
  stubFetch(() => okRows(93632));
  let r = await call(freshSite({ groups: 'birds' }));
  let b = await bodyOf(r);
  check('紀錄數超過取樣上限時 sample.complete 為 false', b.sample.complete === false, b.sample.complete);
  check('notes 明說是取樣', b.notes.some(n => n.includes('取樣')), JSON.stringify(b.notes));
  check('notes 明說不能當成完整名錄',
    b.notes.some(n => n.includes('不能') && (n.includes('只有這些') || n.includes('最常見'))),
    JSON.stringify(b.notes));
  check('notes 說明 total 取自 meta.total 是準的',
    b.notes.some(n => n.includes('meta.total')), JSON.stringify(b.notes));
  check('回應標明資料來源', /TBN/.test(b.source) && /tbn\.org\.tw/.test(b.sourceUrl),
    b.source + ' ' + b.sourceUrl);

  // 紀錄數未超過上限：清單就是完整的，這時說「取樣」反而是錯的
  stubFetch(() => okRows(1));
  r = await call(freshSite({ groups: 'birds' }));
  b = await bodyOf(r);
  check('紀錄數未超過上限時 complete 為 true', b.sample.complete === true, b.sample.complete);
  check('此時 notes 不說是取樣', !b.notes.some(n => n.includes('取樣結果')), JSON.stringify(b.notes));
}

// ── 9. 上游故障：不要回空清單裝作沒事 ───────────────────────────────────
{
  stubFetch(() => new Response('upstream down', { status: 502 }));
  const r = await call(freshSite({ groups: 'birds,mammals' }));
  check('所有類群都失敗時回 503，而不是 200 空清單', r.status === 503, r.status);

  stubFetch(url => new URL(url).searchParams.get('taxonGroup') === 'birds'
    ? okRows(5)
    : new Response('nope', { status: 500 }));
  const r2 = await call(freshSite({ groups: 'birds,mammals' }));
  const b2 = await bodyOf(r2);
  check('部分類群失敗仍回 200 與可用資料', r2.status === 200 && b2.species.length === 1,
    r2.status + ' ' + (b2 && b2.species && b2.species.length));
  check('失敗的類群在回應裡被交代清楚', Array.isArray(b2.failed) && b2.failed.length === 1,
    JSON.stringify(b2 && b2.failed));

  // 上游回了 HTML（忙碌頁）而不是 JSON
  stubFetch(() => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const r3 = await call(freshSite({ groups: 'birds' }));
  check('上游回非 JSON 時視為失敗', r3.status === 503, r3.status);
}

// ── 10. 快取：同一基地的重複查詢不再打上游 ──────────────────────────────
{
  stubFetch(() => okRows(5));
  // 這一區塊刻意重複同一組座標——那正是要測的東西
  const site = freshSite({ groups: 'birds' });
  let r = await call(site);
  let b = await bodyOf(r);
  const firstCalls = calls.length;
  check('第一次是 miss', b.cache === 'miss' && firstCalls === 1, b.cache + ' ' + firstCalls);

  r = await call(site);
  b = await bodyOf(r);
  check('第二次命中快取，沒有再打上游', b.cache === 'hit' && calls.length === firstCalls,
    b.cache + ' ' + calls.length);

  // 小數第四位之後的微調（約一公尺）視為同一處，不該讓快取失效
  r = await call({ ...site, lat: site.lat + 0.00000004 });
  b = await bodyOf(r);
  check('座標微調仍命中快取', b.cache === 'hit', b.cache);

  // 半徑不同就是不同查詢
  r = await call({ ...site, r: site.r + 2 });
  b = await bodyOf(r);
  check('換半徑是另一筆查詢（miss）', b.cache === 'miss', b.cache);
}

// ── 11. GET 與 POST 兩種介面等價 ────────────────────────────────────────
{
  stubFetch(() => okRows(5));
  const g = await bodyOf(await call(freshSite({ groups: 'birds' }), null, 'GET'));
  check('GET 介面可用', g && g.species && g.species.length === 1, JSON.stringify(g && g.error));
  check('GET 真的執行了查詢（不是讀到快取）', g.cache === 'miss', g.cache);
  const p = await bodyOf(await call(freshSite({ groups: 'birds' })));
  check('POST 真的執行了查詢（不是讀到快取）', p.cache === 'miss', p.cache);
  check('GET 與 POST 得到相同物種數', p.species.length === g.species.length,
    p.species.length + ' vs ' + g.species.length);
}

globalThis.fetch = realFetch;

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

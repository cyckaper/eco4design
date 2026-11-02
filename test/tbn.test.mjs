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
  // 正式站走自訂網域，但預覽網址只有 netlify.app——漏列的話預覽版會被自己擋掉（實際踩過）
  check('本站 deploy preview 放行',
    originRejected('https://deploy-preview-20--eco4design.netlify.app') === null,
    originRejected('https://deploy-preview-20--eco4design.netlify.app'));
  check('本站 main 分支部署放行', originRejected('https://main--eco4design.netlify.app') === null,
    originRejected('https://main--eco4design.netlify.app'));
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
  check('taxonRank 原樣帶出（前端靠它標非種層級）', magpie && magpie.rank === '種', magpie && magpie.rank);
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

// ── 3b. 線上實測的實際欄位值（文件與實際不符的地方）─────────────────────
// 2026-11-01 實測 TBN 回的保育等級字串是「珍貴稀有保育類野生動物」、
// 「其他應予保育之野生動物」，不是文件所列的「第二級珍貴稀有」「第三級其他應予保育」。
// 後端原樣帶出、不縮寫（縮寫在前端做，兩種寫法都要認得）。
{
  const agg = aggregate([{ group: 'birds', total: 3, rows: [
    rec({ taxonUUID: 'p1', protectedStatusTW: '珍貴稀有保育類野生動物', taxonRank: '種' }),
    rec({ taxonUUID: 'p2', protectedStatusTW: '其他應予保育之野生動物', taxonRank: '種下階層' }),
    rec({ taxonUUID: 'p3', taxonRank: '界', vernacularName: '真菌界', protectedStatusTW: null }),
  ] }], 100);
  const by = id => agg.species.find(x => x.id === id);
  check('實測值「珍貴稀有保育類野生動物」原樣帶出',
    by('p1').protected === '珍貴稀有保育類野生動物', by('p1').protected);
  check('實測值「其他應予保育之野生動物」原樣帶出',
    by('p2').protected === '其他應予保育之野生動物', by('p2').protected);
  check('種下階層的 rank 帶出', by('p2').rank === '種下階層', by('p2').rank);
  check('界層級的 rank 帶出（真菌界不是一個物種）', by('p3').rank === '界', by('p3').rank);
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
  // 一個類群 ＋ 一次不分類群的查詢（只為了範圍總筆數）
  check('查了一個類群外加一次不分類群查詢', calls.length === 2, calls.length);
  const unf = calls.find(c => !new URL(c.url).searchParams.get('taxonGroup'));
  check('不分類群的查詢只取 1 筆（payload 極小）',
    unf && new URL(unf.url).searchParams.get('limit') === '1',
    unf ? new URL(unf.url).searchParams.get('limit') : '沒發出'); 
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

// ── 7. 預設查 12 個設計相關類群，可要求全部 21 個 ───────────────────────
// 逐類群查詢是必須的（實測溪頭 3 km 內鳥類佔 78 %，不分類群抓一千筆的話
// 植物與兩棲幾乎看不到），但 21 個對 TBN 太重——實測它會回 503 保護自己，
// 所以預設只查設計上用得到的 12 個。
{
  const groupStub = url => {
    const g = new URL(url).searchParams.get('taxonGroup');
    const total = g === 'birds' ? 73210 : 300;
    return okJson({ meta: { total },
      data: Array.from({ length: Math.min(total, 100) }, () => rec({ taxonUUID: 'u-' + g, taxonGroup: g })) });
  };
  stubFetch(groupStub);
  let b = await bodyOf(await call(freshSite()));
  check('預設查 12 個類群外加一次不分類群查詢', calls.length === 13, calls.length);
  check('每個類群各一筆物種 → 12 個物種', b.species.length === 12, b.species.length);
  check('total 是各類群 meta.total 之和', b.total === 73210 + 300 * 11, b.total);
  check('類群按總筆數排序，鳥類在最前', b.groups[0].code === 'birds', b.groups[0].code);
  check('回應標明查了幾個類群、是否全部', b.sample.asked === 12 && b.sample.allGroups === false,
    JSON.stringify(b.sample));
  // 預設清單要含設計上最常談的脊椎動物與植被
  const codes = b.groups.map(g => g.code);
  for (const must of ['birds', 'mammals', 'amphibians', 'reptiles', 'angiosperms', 'ferns']) {
    check(`預設類群含 ${must}`, codes.includes(must), codes.join(','));
  }

  stubFetch(groupStub);
  b = await bodyOf(await call(freshSite({ groups: 'all' })));
  check("groups: 'all' 查全部 21 個類群", calls.length === 22, calls.length);
  check("groups: 'all' 時 allGroups 為 true", b.sample.allGroups === true, JSON.stringify(b.sample));
}

// ── 7c. TBN 的 503 是負載保護，要稍候重試 ───────────────────────────────
// 實測連續查詢之後 TBN 自己回 503（277 ms 就回）。那是「稍候再來」，
// 不是「這個類群沒資料」——直接當失敗會讓清單無聲地少掉整個類群。
{
  let hits = 0;
  stubFetch(() => {
    hits++;
    return hits <= 2 ? new Response('busy', { status: 503 }) : okRows(5);
  });
  const b = await bodyOf(await call(freshSite({ groups: 'birds' })));
  check('遇到 503 會重試，最後成功', b && b.species && b.species.length === 1,
    JSON.stringify({ hits, err: b && b.error }));
  check('重試確實多打了一次', hits >= 3, hits);
}

// ── 7d. 沒回應的類群要在 notes 裡交代 ───────────────────────────────────
// 少掉一整個類群而畫面不說，使用者會以為那裡真的沒有那類生物。
{
  stubFetch(url => new URL(url).searchParams.get('taxonGroup') === 'mammals'
    ? new Response('nope', { status: 500 })
    : okRows(5));
  const b = await bodyOf(await call(freshSite({ groups: 'birds,mammals' })));
  check('notes 指出哪些類群沒回應',
    b.notes.some(n => n.includes('哺乳類') && n.includes('沒有回應')), JSON.stringify(b.notes));
  check('notes 說明「不是那裡沒有，而是沒查到」',
    b.notes.some(n => n.includes('不是那裡沒有')), JSON.stringify(b.notes));
}

// ── 7e. 有類群沒回應時：不可宣稱完整、不可進快取（2026-11-02 線上實際發生）──
// TBN 連續查詢後回 429，21 個類群有 19 個被擋、清單只剩 6 個分類群；
// 舊版仍標 sample.complete:true、notes 寫「物種清單涵蓋全部紀錄」，而且把這份殘缺結果
// 快取六小時——重查一次拿回的還是同一份。
{
  stubFetch(url => new URL(url).searchParams.get('taxonGroup') === 'mammals'
    ? new Response('Too Many Requests', { status: 429 })
    : okRows(5));
  const site = freshSite({ groups: 'birds,mammals' });   // 刻意重複同一組座標，測快取
  let b = await bodyOf(await call(site));
  check('有類群失敗時 sample.complete 為 false', b.sample && b.sample.complete === false,
    JSON.stringify(b.sample));
  check('有類群失敗時 notes 不宣稱「涵蓋全部紀錄」', !b.notes.some(n => n.includes('涵蓋全部紀錄')),
    JSON.stringify(b.notes));
  check('有類群失敗時 notes 說明沒回應的類群不在清單內', b.notes.some(n => n.includes('沒有回應的類群不在清單內')),
    JSON.stringify(b.notes));
  const before = calls.length;
  b = await bodyOf(await call(site));
  check('有類群失敗的結果不進快取：重查會再打上游', b.cache === 'miss' && calls.length > before,
    b.cache + ' ' + (calls.length - before));
}
{
  // 429 是「慢一點」：等一下再試一次，成功就不算失敗
  let hits = 0;
  stubFetch(url => {
    if (new URL(url).searchParams.get('taxonGroup') !== 'birds') return okRows(5);
    hits++;
    return hits === 1 ? new Response('Too Many Requests', { status: 429 }) : okRows(5);
  });
  const b = await bodyOf(await call(freshSite({ groups: 'birds' })));
  check('遇到 429 會稍候重試，最後成功', b && b.species && b.species.length === 1 && !b.failed,
    JSON.stringify({ hits, failed: b && b.failed }));
  check('429 重試後的結果標為完整', b.sample && b.sample.complete === true, JSON.stringify(b.sample));
}
{
  // 全部被限流：回 503，原因標 rate_limited，中文訊息請使用者稍候
  stubFetch(() => new Response('Too Many Requests', { status: 429 }));
  const r = await call(freshSite({ groups: 'birds,mammals' }));
  const b = await bodyOf(r);
  check('全部 429 時回 503、reason 為 rate_limited', r.status === 503 && b.reason === 'rate_limited',
    r.status + ' ' + (b && b.reason));
  check('限流的中文訊息請使用者過幾分鐘再試', /過幾分鐘再試/.test(b.zh || ''), b && b.zh);
}

// ── 7b. rangeTotal：不分類群的真實總筆數 ─────────────────────────────────
// 類群總和與不分類群總數會差一點（沒有 taxonGroup 的紀錄；溪頭 3 km 實測差 733 筆）。
// 參考文獻附的網址是不分類群的查詢，讀者點進去看到的是後者——
// 兩個數字不一致，論文裡的引用就站不住腳，所以兩個都要回。
{
  stubFetch(url => {
    const g = new URL(url).searchParams.get('taxonGroup');
    if (!g) return okJson({ meta: { total: 93632 }, data: [rec()] });     // 不分類群
    return okJson({ meta: { total: 500 },                                 // 500 > 收到的 100 筆 → partial
      data: Array.from({ length: 100 }, () => rec({ taxonUUID: 'u-' + g })) });
  });
  const b = await bodyOf(await call(freshSite({ groups: 'birds,mammals' })));
  check('total 是各類群總和（2×500）', b.total === 1000, b.total);
  check('rangeTotal 是不分類群的總數（93632）', b.rangeTotal === 93632, b.rangeTotal);
  check('ungrouped 是兩者差額', b.ungrouped === 93632 - 1000, b.ungrouped);
  check('notes 用 rangeTotal 的數字（與參考文獻網址一致）',
    b.notes.some(n => n.includes('93,632')), JSON.stringify(b.notes[0]));

  // 不分類群那次失敗時不能拖垮整份結果
  stubFetch(url => new URL(url).searchParams.get('taxonGroup')
    ? okRows(5) : new Response('nope', { status: 500 }));
  const b2 = await bodyOf(await call(freshSite({ groups: 'birds' })));
  check('不分類群查詢失敗時仍回 200', b2 && b2.species && b2.species.length === 1,
    JSON.stringify(b2 && b2.error));
  check('此時 rangeTotal 為 null，total 仍可用', b2.rangeTotal === null && b2.total === 5,
    b2.rangeTotal + ' / ' + b2.total);
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
  const b3 = await bodyOf(r3);
  check('上游故障時 reason 標為 upstream', b3.reason === 'upstream', b3.reason);

  // 逾時與上游故障要分得開：紀錄極密集的基地（例如臺大校園 39 萬筆）會逾時，
  // 這時該告訴 Jake「縮小半徑」，而不是「TBN 無法連線」——處理方式完全不同。
  stubFetch(() => new Promise((_, rej) => {
    const e = new Error('aborted'); e.name = 'AbortError'; setTimeout(() => rej(e), 5);
  }));
  const r4 = await call(freshSite({ groups: 'birds,mammals' }));
  const b4 = await bodyOf(r4);
  check('逾時造成的失敗 reason 標為 time_budget', r4.status === 503 && b4.reason === 'time_budget',
    r4.status + ' ' + b4.reason);
  check('逾時的中文訊息叫使用者縮小半徑', /縮小半徑/.test(b4.zh || ''), b4.zh);
}

// ── 10. 快取：同一基地的重複查詢不再打上游 ──────────────────────────────
{
  stubFetch(() => okRows(5));
  // 這一區塊刻意重複同一組座標——那正是要測的東西
  const site = freshSite({ groups: 'birds' });
  let r = await call(site);
  let b = await bodyOf(r);
  const firstCalls = calls.length;
  check('第一次是 miss（一個類群 ＋ 一次不分類群 = 2 次上游）',
    b.cache === 'miss' && firstCalls === 2, b.cache + ' ' + firstCalls);

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

// 棲共生 · 臺灣生物多樣性網絡（TBN）物種查詢
// https://www.tbn.org.tw/ — API v2.6，公開資料不需金鑰
//
// 為什麼需要伺服器端這一層（兩件瀏覽器做不到的事）：
//   1. TBN 不開放 CORS。2026-11-01 從 eco4design.healsdesign.org 實測
//      fetch('https://www.tbn.org.tw/api/v26/occurrence?…') → TypeError: Failed to fetch。
//      所以代查是必須的，不是優化。
//   2. 這個查詢要打 21 次（每個類群一次）才有意義（見下），彙整後只回一份小小的物種清單。
//      在瀏覽器做等於把好幾 MB 的原始紀錄下載到手機上——學生在野外用 4G，這不可行。
//
// 為什麼不放 Edge Function（跟 /api/osm 不同）：
// Edge 每次請求只有 50 ms CPU。這裡要 JSON.parse 約 3 MB、彙整兩千多筆各 64 欄的紀錄，
// 在 Deno 上是數十毫秒，正好踩在天花板上——先前 PDF 解析就是連續四輪頂到這個上限
// 才搬進 Function 的。Node 執行環境是秒級 CPU，這件事該待在這裡。
//
// 為什麼逐類群查詢，而不是一次查完：
// 2026-11-01 實測溪頭（120.795 23.673，半徑 3 km）共 93,632 筆，其中鳥類 73,210 筆（78 %）。
// 單次上限 1000 筆，所以不分類群直接抓一千筆的話，大約 780 筆是鳥，
// 植物、兩棲、昆蟲幾乎看不到——對「這塊地有什麼」是誤導。
// 逐類群各取樣，清單才會跨到各個類群；而每個類群的 meta.total 同時給出該類群的真實總筆數，
// 不必另外再查一次。
//
// 誠實標示：單次上限 1000 筆、而附近動輒數萬筆，所以回傳的物種清單**必然是取樣**，
// 而且是「TBN 回傳的前 N 筆」而非隨機樣本（API 沒有隨機或排序參數）。
// 因此 species 只能支持「這些物種在這裡有紀錄」，不能支持「這裡只有這些物種」或
// 「這些是最常見的物種」。totals 用的是 meta.total，那個數字是準的。
//
// 請求（POST JSON 或 GET query）：{ lat, lon, r, groups?, limit? }
//   lat/lon  十進位度；r 半徑公里（TBN 要求 1–50 的整數）
//   groups   逗號分隔的類群代碼，或 'all'（預設全部 21 個）
//   limit    每個類群取樣筆數，預設 100，上限 1000（TBN 的上限）
// 回應：見本檔末尾的組裝處。只回彙整結果，不回個別紀錄的座標（見下）。
//
// 為什麼不回個別紀錄的座標：
// 敏感物種（保育類等）的座標會被 TBN 模糊化（dataGeneralizations / coordinateUncertaintyInMeters），
// 把點位畫到圖上等於幫人定位受保護的物種，而且模糊過的座標畫成精確點位本身就是假精確。
// 這一版只做彙整（有什麼物種、原生或外來、保育等級），完全避開這個問題。
// 若之後要畫點位，必須尊重並標示模糊化程度。

const API = 'https://www.tbn.org.tw/api/v26/occurrence';
const SITE = 'https://eco4design.healsdesign.org';
const UA = `Qi-Coexistence-TBN/1.0 (+${SITE})`;

// 21 個類群代碼 → 中文標籤。代碼用於查詢參數；紀錄本身的 taxonGroup 欄位回的是中文，
// 所以中文標籤其實以資料為準，這裡的只是類群沒有任何紀錄時的後備顯示值。
const GROUPS = {
  birds: '鳥類', mammals: '哺乳類', reptiles: '爬行類', amphibians: '兩棲類', fishes: '魚類',
  butterflies: '蝶類', moths: '蛾類', dragonflies: '蜻蛉類', beetles: '甲蟲類', spiders: '蜘蛛類',
  crustaceans: '蝦蟹類', snailsshells: '蝸牛與貝類', otherinsects: '其他昆蟲',
  otherinvertebrates: '其他無脊椎', angiosperms: '被子植物', gymnosperms: '裸子植物',
  ferns: '蕨類', lycophytes: '石松類', mosses: '苔蘚', fungi: '真菌類', chromista: '原藻類',
};
const ALL_GROUPS = Object.keys(GROUPS);

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;              // TBN 的單次上限
// 併發與時間預算是量出來的，不是猜的。2026-11-01 線上實測：
//   溪頭（半徑 3 km，9.3 萬筆）：每個類群約 2 秒，21 個類群合計 5–6 秒
//   臺大校園（半徑 2 km，39 萬筆）：多數類群仍約 2 秒，但鳥類 36.5 萬筆要 9 秒，
//                                   不分類群的那次更久（曾直接逾時）
// 延遲幾乎與筆數無關，直到結果集非常大才飆高——也就是只有最大的那一兩個類群慢。
// 原本 concurrency 6 ＋ 預算 20 秒時，臺大校園 21 個類群排不完，全部被跳過而回 503；
// 那是 Jake 自己的校園，學生一定會用。
// pool 是工作池（不是固定批次），所以慢的那個只佔住一個名額，其餘繼續流過去：
// 併發 8 時總時間約是 max(最慢那個, 其餘平均攤完) ≈ 10 秒上下。
const CONCURRENCY = 8;
const PER_REQUEST_TIMEOUT_MS = 14000;
const TOTAL_BUDGET_MS = 23000;       // 函式上限 26 秒，留時間給彙整與回傳
// 不分類群的那次查詢只是為了 rangeTotal（參考文獻用），可有可無，
// 所以給它較短的上限——不能讓一個選配的數字吃掉物種清單的時間。
const RANGE_TOTAL_TIMEOUT_MS = 6000;
const MAX_GROUP_BYTES = 6 * 1024 * 1024;

// 物種名錄不會以小時為單位變動；一班五十個學生分析同一個基地時，
// 快取讓 TBN 只被打 21 次而不是 1050 次。（Lambda 容器各有自己的快取，
// 所以命中率不會是百分之百，但足以把對上游的壓力壓下來。）
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 60;
const cache = new Map();

const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 60;
const rate = new Map();

// 只允許自家站台呼叫（與 /api/osm、/api/pdf-text 同一套規則）。
// TBN 沒有金鑰額度要保護，但仍然不該變成任意人都能拿去打 TBN 的公開代理。
// eco4design.netlify.app 是本站的 netlify.app 網域：分支部署與 deploy preview 都在這裡，
// 正式站雖走自訂網域，預覽網址卻只有 netlify.app——不列的話預覽版會被自己擋掉。
const ALLOWED_ORIGINS = ['*.healsdesign.org', 'eco4design.netlify.app',
  'cycling-roadbook.netlify.app', 'cyckaper.github.io'];
const DEV_HOSTNAMES = ['localhost', '127.0.0.1'];

export function originRejected(origin) {
  if (!origin) return null;            // 沒有 Origin 標頭（curl、伺服器端呼叫）交給速率限制把關
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (_) { return 'malformed'; }
  if (DEV_HOSTNAMES.includes(hostname)) return null;
  const ok = ALLOWED_ORIGINS.some(p => {
    if (p.startsWith('*.')) { const b = p.slice(2); return hostname === b || hostname.endsWith('.' + b); }
    return hostname === p || hostname.endsWith('--' + p);
  });
  return ok ? null : hostname;
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  rate.set(ip, list);
  if (rate.size > 500) { for (const k of rate.keys()) { rate.delete(k); if (rate.size <= 300) break; } }
  return list.length > RATE_MAX;
}

const json = (status, obj, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

// ── 欄位整理 ──────────────────────────────────────────────────────────────
// TBN 的值有幾個固定的怪癖，都在這裡一次處理掉，彙整的部分才不必到處防禦：
//   scientificName 帶 <i> 標籤（用 simplifiedScientificName）
//   nativeness 是中英並列（'原生 Native'）
//   endemism 用「臺」不是「台」
//   individualCount、minimumElevationInMeters 是字串不是數字
//   沒有 eventDate，只有 year / month / day

// 取中文部分：'原生 Native' → '原生'、'外來歸化 Naturalized' → '外來歸化'
export function zhPart(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const cut = s.replace(/\s*[A-Za-z][A-Za-z\s().,'-]*$/, '').trim();
  return cut || s;
}

// '暫無危機（LC, Least Concern）' → 'LC'；取不到代碼就回 null（完整字串另外保留）
export function statusCode(v) {
  if (!v) return null;
  const m = String(v).match(/[（(]\s*([A-Z]{2,3})\b/);
  return m ? m[1] : null;
}

// 這些字串會進到報告與（可能）送去判讀的提示詞裡，所以清掉控制字元與角括號，
// 並限制長度。TBN 的資料是第三方內容，當資料看待、不當指令看待。
export function clean(v, max = 120) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function badParams(lat, lon, r, limit) {
  if (lat === null || lat < -90 || lat > 90) return 'lat out of range';
  if (lon === null || lon < -180 || lon > 180) return 'lon out of range';
  if (r === null || !Number.isInteger(r) || r < 1 || r > 50) return 'r must be an integer 1–50 (km)';
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit must be 1–${MAX_LIMIT}`;
  return null;
}

// group 為 null 時不帶 taxonGroup：用來取整個範圍的真實總筆數（見 rangeTotal）
async function fetchGroup(lon, lat, r, group, limit, deadline, cap) {
  const left = deadline - Date.now();
  if (left < 1500) return { group, error: 'skipped: time budget exhausted' };

  const url = `${API}?circle=${encodeURIComponent(`${lon} ${lat},${r}`)}&limit=${limit}`
    + (group ? `&taxonGroup=${encodeURIComponent(group)}` : '');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(cap || PER_REQUEST_TIMEOUT_MS, left));
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA, referer: SITE },
      signal: ac.signal,
    });
    if (!res.ok) return { group, error: 'http_' + res.status };
    const text = await res.text();
    if (text.length > MAX_GROUP_BYTES) return { group, error: 'response too large' };
    let body;
    try { body = JSON.parse(text); } catch (_) { return { group, error: 'non-JSON response' }; }
    const rows = Array.isArray(body && body.data) ? body.data : [];
    const total = body && body.meta && typeof body.meta.total === 'number' ? body.meta.total : null;
    return { group, total, rows };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
    return { group, error: aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// 併發有上限的工作池：對上游客氣，也避免一次開 21 條連線
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const at = i++; out[at] = await fn(items[at]); }
  });
  await Promise.all(workers);
  return out;
}

// ── 彙整 ──────────────────────────────────────────────────────────────────
// 以 taxonUUID 為鍵（TBN 自己的物種識別碼），不用學名字串：
// 同一物種的 simplifiedScientificName 可能帶或不帶命名者而拼出兩筆。
export function aggregate(results, groupLimit) {
  const species = new Map();
  const datasets = new Map();
  const groups = [];
  const failed = [];
  let sampled = 0;

  for (const res of results) {
    const zhLabel = GROUPS[res.group] || res.group;
    if (res.error) {
      failed.push({ group: res.group, zh: zhLabel, error: res.error });
      continue;
    }
    const rows = res.rows || [];
    sampled += rows.length;
    const inGroup = new Set();

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;

      const id = clean(row.taxonUUID, 64)
        || clean(row.simplifiedScientificName, 160)
        || clean(row.vernacularName, 80);
      if (!id) continue;
      inGroup.add(id);

      let s = species.get(id);
      if (!s) {
        s = {
          id,
          sci: clean(row.simplifiedScientificName, 160) || clean(row.scientificName, 160),
          zh: clean(row.vernacularName, 80),
          famSci: clean(row.familyScientificName, 80),
          famZh: clean(row.familyVernacularName, 40),
          group: clean(row.taxonGroup, 24) || zhLabel,
          groupCode: res.group,
          rank: clean(row.taxonRank, 12),
          taicol: clean(row.taiCOLTaxonID, 40),
          protected: zhPart(clean(row.protectedStatusTW, 60)),
          redlist: statusCode(row.categoryRedlistTW),
          redlistFull: clean(row.categoryRedlistTW, 60),
          iucn: statusCode(row.categoryIUCN),
          endemic: null,
          nativeness: zhPart(clean(row.nativeness, 40)),
          estab: zhPart(clean(row.degreeOfEstablishment, 40)),
          n: 0,
          years: null,
          elev: null,
          blurred: false,
          uncertainty: null,
          sensitive: null,
        };
        // endemism 的值是「臺灣特有」／「非臺灣特有」。資料用「臺」，舊文件寫「台」，兩者都接受。
        const end = clean(row.endemism, 40);
        if (end) s.endemic = /^非/.test(end) ? false : /[台臺]灣特有/.test(end) ? true : null;
        species.set(id, s);
      }

      s.n++;
      const y = num(row.year);
      if (y && y > 1700 && y <= new Date().getFullYear() + 1) {
        s.years = s.years ? [Math.min(s.years[0], y), Math.max(s.years[1], y)] : [y, y];
      }
      const e = num(row.minimumElevationInMeters);
      if (e !== null) s.elev = s.elev ? [Math.min(s.elev[0], e), Math.max(s.elev[1], e)] : [e, e];

      if (row.dataGeneralizations === true) s.blurred = true;
      const unc = num(row.coordinateUncertaintyInMeters);
      if (unc !== null) s.uncertainty = s.uncertainty === null ? unc : Math.max(s.uncertainty, unc);
      const sens = clean(row.dataSensitiveCategory, 40) || clean(row.sensitiveCategory, 40);
      if (sens && sens !== '無' && !s.sensitive) s.sensitive = sens;

      // 出處：OGDL-1.0 與學術引用都需要，逐筆紀錄自己就帶著
      const dsName = clean(row.datasetName, 160);
      if (dsName) {
        const key = dsName + '|' + (clean(row.datasetUUID, 64) || '');
        let d = datasets.get(key);
        if (!d) {
          d = { name: dsName, publisher: clean(row.datasetPublisher, 120),
                author: clean(row.datasetAuthor, 120), license: clean(row.license, 40),
                uuid: clean(row.datasetUUID, 64), n: 0 };
          datasets.set(key, d);
        }
        d.n++;
      }
    }

    groups.push({
      code: res.group, zh: zhLabel,
      total: res.total,
      sampled: rows.length,
      species: inGroup.size,
      // 這個類群的紀錄比取樣數多，所以它的物種清單不完整
      partial: typeof res.total === 'number' && res.total > rows.length,
    });
  }

  const list = [...species.values()].sort((a, b) =>
    (b.n - a.n) || String(a.zh || a.sci || '').localeCompare(String(b.zh || b.sci || ''), 'zh-Hant'));

  return {
    groups: groups.sort((a, b) => (b.total || 0) - (a.total || 0)),
    failed,
    species: list,
    datasets: [...datasets.values()].sort((a, b) => b.n - a.n),
    licenses: [...new Set([...datasets.values()].map(d => d.license).filter(Boolean))].sort(),
    sampled,
    groupLimit,
  };
}

// ── 端點 ──────────────────────────────────────────────────────────────────
export default async (request, context) => {
  const startedAt = Date.now();

  const origin = request.headers.get('origin');
  const rejected = originRejected(origin);
  const cors = {
    'access-control-allow-origin': origin && !rejected ? origin : '*',
    'vary': 'origin',
    'access-control-expose-headers': 'x-tbn-cache',
  };

  if (request.method === 'OPTIONS') {
    if (rejected) return json(403, { error: 'Origin not allowed', origin: rejected });
    return new Response(null, { status: 204, headers: { ...cors,
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' }, cors);
  }
  if (rejected) return json(403, { error: 'Origin not allowed', origin: rejected }, cors);

  const ip = (context && context.ip) || request.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) return json(429, { error: 'Too many requests' }, cors);

  // 參數可以走 GET query 或 POST JSON，兩種都支援
  let p = {};
  if (request.method === 'GET') {
    p = Object.fromEntries(new URL(request.url).searchParams.entries());
  } else {
    try { p = await request.json(); } catch (_) { return json(400, { error: 'Malformed JSON body' }, cors); }
    if (!p || typeof p !== 'object') return json(400, { error: 'Malformed body' }, cors);
  }

  const lat = num(p.lat), lon = num(p.lon);
  const r = num(p.r) === null ? null : Math.round(num(p.r));
  const limit = p.limit === undefined || p.limit === '' ? DEFAULT_LIMIT : Math.round(num(p.limit));
  const bad = badParams(lat, lon, r, limit);
  if (bad) return json(400, { error: 'Rejected request: ' + bad }, cors);

  let groups = ALL_GROUPS;
  const asked = typeof p.groups === 'string' ? p.groups.trim() : '';
  if (asked && asked !== 'all') {
    const want = asked.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = want.filter(g => !GROUPS[g]);
    if (unknown.length) {
      return json(400, { error: 'Unknown taxon group(s): ' + unknown.slice(0, 5).join(', '),
                         known: ALL_GROUPS }, cors);
    }
    groups = want;
  }

  // 經緯度取到小數四位（約 11 公尺）當快取鍵：微調基地點不該讓快取全部失效
  const key = [lat.toFixed(4), lon.toFixed(4), r, limit, groups.join('+')].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key); cache.set(key, hit);   // 最近使用的排到最後
    return json(200, { ...hit.body, cache: 'hit', ms: Date.now() - startedAt },
      { ...cors, 'x-tbn-cache': 'hit' });
  }

  const deadline = startedAt + TOTAL_BUDGET_MS;
  // 多一個 null：不分類群的查詢，只為了 meta.total（limit=1，payload 極小）
  const all = await pool([...groups, null], CONCURRENCY,
    g => fetchGroup(lon, lat, r, g, g === null ? 1 : limit, deadline,
      g === null ? RANGE_TOTAL_TIMEOUT_MS : PER_REQUEST_TIMEOUT_MS));
  const unfiltered = all[all.length - 1];
  const results = all.slice(0, -1);
  const agg = aggregate(results, limit);
  const rangeTotal = unfiltered && !unfiltered.error && typeof unfiltered.total === 'number'
    ? unfiltered.total : null;

  // 全部類群都失敗：這是故障，不要回一份空清單裝作沒事。
  // 分辨兩種原因：上游真的壞了，或是時間預算不夠（紀錄極密集的基地會這樣）——
  // 訊息不同，Jake 才知道該重試還是該縮小半徑。
  if (agg.failed.length === groups.length) {
    const starved = agg.failed.filter(f => /budget|timeout/.test(f.error || '')).length;
    const timeRelated = starved > agg.failed.length / 2;
    return json(503, {
      error: timeRelated
        ? 'TBN did not answer in time — this area has a very large number of records; try a smaller radius'
        : 'TBN is unavailable',
      reason: timeRelated ? 'time_budget' : 'upstream',
      zh: timeRelated
        ? '這個範圍的紀錄筆數太多，TBN 來不及回應——請縮小半徑再試'
        : 'TBN 目前無法連線',
      failed: agg.failed.slice(0, 5), ms: Date.now() - startedAt,
    }, cors);
  }

  const total = agg.groups.reduce((a, g) => a + (g.total || 0), 0);
  const anyPartial = agg.groups.some(g => g.partial);
  const body = {
    source: 'TBN 臺灣生物多樣性網絡',
    sourceUrl: 'https://www.tbn.org.tw/',
    site: { lat, lon, r },
    total,                                   // 各類群 meta.total 之和——這個數字是準的
    // 不分類群的總筆數。通常比 total 略多，差額是沒有 taxonGroup 的紀錄
    // （溪頭 3 km：93,632 對 92,899，差 733 筆）。參考文獻的網址是這個查詢。
    rangeTotal,
    ungrouped: rangeTotal !== null ? Math.max(0, rangeTotal - total) : null,
    sample: { perGroup: limit, records: agg.sampled, groups: agg.groups.length,
              complete: !anyPartial },
    groups: agg.groups,
    species: agg.species,
    datasets: agg.datasets,
    licenses: agg.licenses,
    ...(agg.failed.length ? { failed: agg.failed } : {}),
    // 這段話會原樣顯示在介面與報告上。取樣的性質必須跟著資料一起走，
    // 不能只寫在文件裡——看報告的人看不到文件。
    notes: anyPartial ? [
      `物種清單是取樣結果：每個類群最多取 ${limit} 筆紀錄，而這個範圍內共有 ${(rangeTotal || total).toLocaleString('en-US')} 筆。`,
      '取的是 TBN 回傳的前幾筆，不是隨機樣本，所以清單可以說明「這些物種在這裡有紀錄」，但不能說明「這裡只有這些物種」，也不能用來判斷哪些最常見。',
      '各類群的總筆數（total）取自 TBN 的 meta.total，那個數字是完整範圍的真實筆數。',
    ] : [
      '這個範圍內的紀錄筆數未超過取樣上限，物種清單涵蓋全部紀錄。',
    ],
    cache: 'miss',
    ms: Date.now() - startedAt,
  };

  cache.set(key, { at: Date.now(), body });
  if (cache.size > CACHE_MAX) { for (const k of cache.keys()) { cache.delete(k); if (cache.size <= CACHE_MAX) break; } }

  return json(200, body, { ...cors, 'x-tbn-cache': 'miss' });
};

export const config = { path: '/api/tbn' };

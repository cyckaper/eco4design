// 棲共生 · 物種保育等級與特有性查詢（Netlify Edge Function / Deno）
// 目的：iNaturalist 在地觀察卡片標出「保育類」（《野生動物保育法》第 I／II／III 級；文資法珍貴稀有植物）
//       與「臺灣特有種」，協助使用者依保育意義挑選焦點物種，而不是只看觀察筆數。
//
// 查詢來源：臺灣物種名錄 TaiCOL API v2（api.taicol.tw/v2/taxon；公開、不需金鑰，但不支援瀏覽器跨網域呼叫，所以由本站代查）
//   1. scientific_name=<學名>（可對到異名）；查無時改用中文俗名（common_name）
//   2. 物種已列 II／III 級，或紅皮書受脅卻沒有保育等級時，再以 taxon_group 取其下的亞種、變種
//      （保育類有時以臺灣的亞種列名較嚴格的等級，例如石虎）
//   台灣生物多樣性網絡 TBN API 對本站伺服器回應 403，因此不使用。
//
// 請求（POST JSON）：{ taxa: [{ sci: 'Psilopogon nuchalis', zh: '五色鳥' }, …] }（最多 MAX_TAXA 筆）
// 回應 JSON：{ results: { [sci]: { protected, protectedScope, endemic, endemicRank, source, id } }, pending: [sci…] }
//   protected      'I' | 'II' | 'III' | 'CHPA'（文資法珍貴稀有植物）| null（查得、非保育類）
//   protectedScope 'self'（查詢的分類群本身列名）| 'infra'（物種本身沒有、或等級較低，而在臺灣的亞種／變種列名較嚴格的等級）| null
//   endemic        true | false | null（名錄沒有資料）；只看查詢的分類群本身
//   endemicRank    'Species' | 'Subspecies' | 'Variety' …（特有的是哪一階層；查詢的是亞種時為特有亞種）| null
//   source         'TaiCOL' | null（名錄查不到）
//   pending        名錄沒有回應、時間內沒查完的學名，前端稍後再查
//
// 不需通行碼（iNaturalist 面板在輸入通行碼之前就會顯示）；以學名格式檢查、筆數上限、
// 單一執行個體內的 IP 速率限制與 24 小時快取防止被當成公開代理濫用。

const MAX_TAXA = 30;                  // 每次請求最多查詢筆數（前端分批送出）
const MAX_BODY_BYTES = 16 * 1024;
const CONCURRENCY = 6;                // 同時查詢筆數
const UPSTREAM_TIMEOUT_MS = 8000;     // 每個上游請求
const TOTAL_TIMEOUT_MS = 25000;       // 整體上限（Edge 回應標頭須在 40 秒內送出）
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 4000;
const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 240;  // 同一來源 IP 每 5 分鐘最多 240 次請求（單一執行個體內；教室共用一個對外 IP 時也夠用）

const TAICOL_API = 'https://api.taicol.tw/v2/taxon';
const UA = 'Qi-Coexistence-TaxonStatus/1.0 (+https://eco4design.healsdesign.org)';

const SCI_RE = /^[A-Z][a-zë-]+(?: [a-zë-]+){0,3}$/;            // 屬名大寫開頭，最多到亞種／變種（四段）
const ZH_RE = /^[㐀-鿿豈-﫿·・（）()\-\s A-Za-z]{1,40}$/;
const LEVEL_ORDER = { I: 1, II: 2, III: 3, CHPA: 4 };          // 數字愈小愈嚴格

const cache = new Map();   // sci → { at, value }
const rate = new Map();    // ip → [timestamps]

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

function rateLimited(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  list.push(now);
  rate.set(ip, list);
  if (rate.size > 5000) { for (const k of rate.keys()) { rate.delete(k); if (rate.size <= 4000) break; } }
  return list.length > RATE_MAX;
}

function cacheGet(sci) {
  const hit = cache.get(sci);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(sci); return undefined; }
  return hit.value;
}
function cacheSet(sci, value) {
  cache.set(sci, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) { for (const k of cache.keys()) { cache.delete(k); if (cache.size <= CACHE_MAX * 0.8) break; } }
}

async function fetchJson(url, deadline) {
  const left = deadline - Date.now();
  if (left <= 300) return { err: 'deadline' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(UPSTREAM_TIMEOUT_MS, left));
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return { err: 'http_' + res.status };
    const len = +(res.headers.get('content-length') || 0);
    if (len > MAX_UPSTREAM_BYTES) return { err: 'too_large' };
    const text = await res.text();
    if (text.length > MAX_UPSTREAM_BYTES) return { err: 'too_large' };
    let data;
    try { data = JSON.parse(text); } catch (_) { return { err: 'bad_json' }; }
    // TaiCOL 以 HTTP 200 回傳參數錯誤：{ status: { code: 400, message } }
    const code = data && data.status && +data.status.code;
    if (code && code !== 200) return { err: 'api_' + code };
    return { data };
  } catch (e) {
    return { err: ac.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// ── 正規化 ──
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ');
const normName = (s) => stripTags(s).toLowerCase().replace(/\s+/g, ' ').trim();
// 學名去掉命名者、年代與 var.／subsp.：「Keteleeria davidiana var. formosana」→「keteleeria davidiana formosana」
const bareName = (s) => normName(s).split(' ').filter(w => /^[a-zë-]+$/.test(w) && !/^(var|subsp|ssp|f|fo|forma)\.?$/.test(w)).slice(0, 4).join(' ');
const isSpecies = (d) => /^species$/i.test(String(d && d.rank || ''));
const usable = (arr) => arr.filter(d => d && typeof d === 'object' && !/deleted|刪除/i.test(String(d.taxon_status || '')));
const recordsOf = (body) => Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];

function truthy(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return v == null ? null : false;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'null' || s === 'none') return null;
  if (['false', '0', 'n', 'no', 'f', '否'].includes(s) || /非特有|non-?endemic|not endemic/.test(s)) return false;
  if (['true', '1', 'y', 'yes', 't', '是'].includes(s) || /特有|endemic/.test(s)) return true;
  return null;
}

// 保育等級：TaiCOL 的 protected 用代碼 I／II／III，「1」是文資法珍貴稀有植物；也容許中文全名的寫法
function levelOf(v) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v.join(' ') : v).trim();
  if (!s || /^(null|none|無|否|false|0|-)$/i.test(s)) return null;
  if (s === '1' || /CHPA|文化資產|文資|珍貴稀有植物/i.test(s)) return 'CHPA';
  const roman = s.match(/(?:^|[^A-Za-z])(III|II|I)(?:[^A-Za-z]|$)/);
  if (roman) return roman[1];
  if (/第一級|瀕臨絕種|第\s*1\s*級/.test(s)) return 'I';
  if (/第二級|珍貴稀有|第\s*2\s*級/.test(s)) return 'II';
  if (/第三級|其他應予保育|第\s*3\s*級/.test(s)) return 'III';
  return null;
}

function pickByName(arr, target) {
  const nameOf = (d) => bareName(d.simple_name || d.scientific_name || d.formatted_name || d.name || '');
  return arr.find(d => nameOf(d) === target && /accepted|有效/i.test(String(d.taxon_status || 'accepted'))) || arr.find(d => nameOf(d) === target) || null;
}
function pickBySynonym(arr, target) {
  const syn = (d) => stripTags(d.synonyms || d.formatted_synonyms || '').split(/[,;，、]/).map(bareName).filter(Boolean);
  return arr.find(d => syn(d).includes(target)) || null;
}
function pickByZh(arr, zh) {
  const alt = (d) => String(d.alternative_name_c || '').split(/[,;，、]/).map(s => s.trim());
  const hits = arr.filter(d => d.common_name_c === zh || alt(d).includes(zh));
  return hits.find(isSpecies) || hits[0] || null;
}

// 查詢的分類群本身＋（若是種）在臺灣的亞種、變種 → 卡片要標的等級
function summarize(base, group) {
  const baseName = bareName(base.simple_name || '');
  const infra = isSpecies(base)
    ? group.filter(d => d !== base && !isSpecies(d) && d.is_in_taiwan !== false &&
        (d.parent_taxon_id === base.taxon_id || bareName(d.simple_name || '').startsWith(baseName + ' ')))
    : [];
  let level = levelOf(base.protected);
  let scope = level ? 'self' : null;
  for (const d of infra) {
    const l = levelOf(d.protected);
    if (l && (!level || LEVEL_ORDER[l] < LEVEL_ORDER[level])) { level = l; scope = 'infra'; }
  }
  const endemic = truthy(base.is_endemic);
  return {
    protected: level,
    protectedScope: scope,
    endemic,
    endemicRank: endemic ? (String(base.rank || '') || null) : null,
    source: 'TaiCOL',
    id: base.taxon_id || null,
  };
}

const EMPTY = { protected: null, protectedScope: null, endemic: null, endemicRank: null, source: null, id: null };

// 需要看臺灣的亞種、變種的情形：物種已列 II／III 級（亞種可能更嚴格，例如石虎：豹貓 II、臺灣的亞種 I），
// 或國家紅皮書列為受脅（NCR／NEN／NVU）或接近受脅（NNT）卻沒有保育等級。
// TaiCOL 的 taxon_group 查詢一次要 2–4 秒，只在這些情形才查，其餘物種只用一次 scientific_name 查詢（約 0.1–0.3 秒）。
function needsInfra(base) {
  if (!isSpecies(base)) return false;
  const level = levelOf(base.protected);
  if (level === 'II' || level === 'III') return true;
  return !level && /^N(CR|EN|VU|NT)$/i.test(String(base.redlist || '').trim());
}

async function lookup(sci, zh, deadline, debug) {
  const trace = debug ? [] : null;
  const note = (q, r, t0) => { if (trace) trace.push({ q, err: r.err || null, n: r.data ? recordsOf(r.data).length : null, ms: Date.now() - t0 }); };
  const enc = encodeURIComponent;
  const target = bareName(sci);
  let failed = false;   // 名錄沒有回應（逾時、錯誤）：結果可能不完整
  let base = null, group = null, r, t0;

  // 1) 學名（有效名或異名）
  t0 = Date.now();
  r = await fetchJson(`${TAICOL_API}?scientific_name=${enc(sci)}`, deadline);
  note('sci', r, t0);
  if (r.err) failed = true;
  else { const arr = usable(recordsOf(r.data)); base = pickByName(arr, target) || pickBySynonym(arr, target); }
  // 2) 查無：中文俗名
  if (!base && !failed && zh) {
    t0 = Date.now();
    r = await fetchJson(`${TAICOL_API}?common_name=${enc(zh)}`, deadline);
    note('zh', r, t0);
    if (r.err) failed = true;
    else base = pickByZh(usable(recordsOf(r.data)), zh);
  }
  if (!base) return failed ? { pending: true, trace } : { value: EMPTY, trace };

  // 3) 必要時取其下在臺灣的亞種、變種
  if (needsInfra(base) && base.simple_name) {
    t0 = Date.now();
    r = await fetchJson(`${TAICOL_API}?taxon_group=${enc(base.simple_name)}&limit=50`, deadline);
    note('group', r, t0);
    if (r.err) failed = true;
    else group = usable(recordsOf(r.data));
  }
  return { value: summarize(base, group || [base]), transient: failed, trace };
}

export default async (request, context) => {
  const url = new URL(request.url);
  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || 'unknown';

  // 暫時偵錯（合併前移除）：GET ?debug=time&group=…[&rank=…][&limit=…] → taxon_group 查詢耗時
  if (request.method === 'GET' && url.searchParams.get('debug') === 'time') {
    if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);
    const g = (url.searchParams.get('group') || '').trim();
    if (!SCI_RE.test(g)) return json({ error: 'Bad name' }, 400);
    const q = new URLSearchParams({ taxon_group: g });
    for (const k of ['rank', 'limit', 'is_in_taiwan']) if (url.searchParams.get(k)) q.set(k, url.searchParams.get(k).slice(0, 20));
    const t0 = Date.now();
    const r = await fetchJson(`${TAICOL_API}?${q}`, Date.now() + TOTAL_TIMEOUT_MS);
    return json({ ms: Date.now() - t0, err: r.err || null, n: r.data ? recordsOf(r.data).length : null,
      names: r.data ? recordsOf(r.data).map(d => `${d.simple_name} ${d.rank} ${d.protected}`) : null });
  }

  // 暫時偵錯（合併前移除）：GET ?debug=1&sci=…&zh=…
  if (request.method === 'GET' && url.searchParams.get('debug') === '1') {
    if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);
    const sci = (url.searchParams.get('sci') || '').trim();
    const zh = (url.searchParams.get('zh') || '').trim();
    if (!SCI_RE.test(sci)) return json({ error: 'Bad scientific name' }, 400);
    return json(await lookup(sci, ZH_RE.test(zh) ? zh : '', Date.now() + TOTAL_TIMEOUT_MS, true));
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch (_) { return json({ error: 'Bad JSON' }, 400); }
  const list = Array.isArray(body?.taxa) ? body.taxa : null;
  if (!list) return json({ error: 'Missing taxa' }, 400);
  if (list.length > MAX_TAXA) return json({ error: `At most ${MAX_TAXA} taxa per request` }, 413);

  const seen = new Set();
  const items = [];
  for (const t of list) {
    const sci = String(t?.sci || '').replace(/\s+/g, ' ').trim();
    const zh = String(t?.zh || '').trim();
    if (!SCI_RE.test(sci) || seen.has(sci)) continue;
    seen.add(sci);
    items.push({ sci, zh: ZH_RE.test(zh) ? zh : '' });
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const results = {};
  const pending = [];
  const queue = [];
  for (const it of items) {
    const hit = cacheGet(it.sci);
    if (hit !== undefined) results[it.sci] = hit;
    else queue.push(it);
  }

  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const it = queue[next++];
      if (Date.now() > deadline - 500) { pending.push(it.sci); continue; }
      const r = await lookup(it.sci, it.zh, deadline, false);
      if (r.pending) { pending.push(it.sci); continue; }
      results[it.sci] = r.value;
      if (!r.transient) cacheSet(it.sci, r.value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return json({ results, pending });
};

export const config = { path: '/api/taxon-status' };

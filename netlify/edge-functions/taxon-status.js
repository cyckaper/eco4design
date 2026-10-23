// 棲共生 · 物種保育等級與特有性查詢（Netlify Edge Function / Deno）
// 目的：iNaturalist 在地觀察卡片標出「保育類」（《野生動物保育法》第 I／II／III 級；文資法珍貴稀有植物）
//       與「臺灣特有種」，協助使用者依保育意義挑選焦點物種，而不是只看觀察筆數。
//
// 查詢來源（公開名錄，不需金鑰；兩者都不支援瀏覽器跨網域呼叫，所以由本站代查）：
//   1. 臺灣物種名錄 TaiCOL API v2（api.taicol.tw/v2/taxon）：以學名查詢；查無時改用中文俗名
//   2. 台灣生物多樣性網絡 TBN API v2.5（www.tbn.org.tw/api/v25/taxon）：TaiCOL 查無、或物種層級沒有保育等級時，
//      連同下一階層（亞種）一起查，補上「亞種為保育類」的情形（例如部分鳥類以臺灣亞種列名）
//
// 請求（POST JSON）：{ taxa: [{ sci: 'Psilopogon nuchalis', zh: '五色鳥' }, …] }（最多 MAX_TAXA 筆）
// 回應 JSON：{ results: { [sci]: { protected, protectedScope, endemic, source, id } }, pending: [sci…] }
//   protected      'I' | 'II' | 'III' | 'CHPA'（文資法珍貴稀有植物）| null（查得、非保育類）
//   protectedScope 'species' | 'subspecies' | null
//   endemic        true | false | null（名錄沒有資料）
//   source         'TaiCOL' | 'TBN' | null（兩個名錄都查不到）
//   pending        時間內沒查完的學名，前端稍後再查
//
// 不需通行碼（iNaturalist 面板在輸入通行碼之前就會顯示）；以學名格式檢查、筆數上限、
// 單一執行個體內的 IP 速率限制與 24 小時快取防止被當成公開代理濫用。

const MAX_TAXA = 30;                  // 每次請求最多查詢筆數（前端分批送出）
const MAX_BODY_BYTES = 16 * 1024;
const CONCURRENCY = 6;                // 同時查詢筆數
const UPSTREAM_TIMEOUT_MS = 8000;     // 每個上游請求
const TOTAL_TIMEOUT_MS = 25000;       // 整體上限（Edge 回應標頭須在 40 秒內送出）
const MAX_UPSTREAM_BYTES = 512 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 4000;
const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 240;  // 同一來源 IP 每 5 分鐘最多 240 次請求（單一執行個體內；教室共用一個對外 IP 時也夠用）

const TAICOL_API = 'https://api.taicol.tw/v2/taxon';
const TBN_API = 'https://www.tbn.org.tw/api/v25/taxon';
const UA = 'Qi-Coexistence-TaxonStatus/1.0 (+https://eco4design.healsdesign.org)';

const SCI_RE = /^[A-Z][a-zë-]+(?: [a-zë-]+){0,3}$/;            // 屬名大寫開頭，最多到亞種／變種（四段）
const ZH_RE = /^[㐀-鿿豈-﫿·・（）()\-\s A-Za-z]{1,40}$/;

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
    try { return { data: JSON.parse(text) }; } catch (_) { return { err: 'bad_json' }; }
  } catch (e) {
    return { err: ac.signal.aborted ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

// ── 正規化 ──
const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ');
const normName = (s) => stripTags(s).toLowerCase().replace(/\s+/g, ' ').trim();
// 學名去掉命名者與年代：「Psilopogon nuchalis (Gould, 1863)」→「psilopogon nuchalis」
const bareName = (s) => normName(s).split(' ').filter(w => /^[a-zë-]+$/.test(w) && !/^(var|subsp|ssp|f)\.?$/.test(w)).slice(0, 4).join(' ');

function truthy(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return v == null ? null : false;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'null' || s === 'none') return null;
  if (['false', '0', 'n', 'no', 'f', '否'].includes(s) || /非特有|non-?endemic|not endemic/.test(s)) return false;
  if (['true', '1', 'y', 'yes', 't', '是'].includes(s) || /特有|endemic/.test(s)) return true;
  if (/原生|native|外來|alien|歸化|naturali[sz]ed|栽培|cultivated/.test(s)) return false;
  return null;
}

// 保育等級：TaiCOL 用代碼（I／II／III；「1」是文資法珍貴稀有植物），
// TBN 用全名（「瀕臨絕種保育類野生動物」「珍貴稀有保育類野生動物」「其他應予保育之野生動物」「文化資產保存法：珍貴稀有植物」，
// 有時前面加「第一級、」）
function normProtected(v) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v.join(' ') : v).trim();
  if (!s || /^(null|none|無|否|false|0|-)$/i.test(s)) return null;
  if (/CHPA|文化資產|文資|珍貴稀有植物/i.test(s)) return 'CHPA';
  const roman = s.match(/(?:^|[^A-Za-z])(III|II|I)(?:[^A-Za-z]|$)/);
  if (roman) return roman[1];
  if (/第一級|瀕臨絕種|第\s*1\s*級/.test(s)) return 'I';
  if (/第二級|珍貴稀有|第\s*2\s*級/.test(s)) return 'II';
  if (/第三級|其他應予保育|第\s*3\s*級/.test(s)) return 'III';
  return null;
}

const recordsOf = (body) => Array.isArray(body?.data) ? body.data : Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];

function pickTaicol(body, sci, zh) {
  const arr = recordsOf(body).filter(d => d && !/deleted|刪除/i.test(String(d.taxon_status || '')));
  const target = bareName(sci);
  const nameOf = (d) => bareName(d.simple_name || d.scientific_name || d.formatted_name || d.name || '');
  const synonymsOf = (d) => String(stripTags(d.synonyms || d.formatted_synonyms || '')).split(/[,;，、]/).map(bareName).filter(Boolean);
  const accepted = (d) => !d.taxon_status || /accepted|有效/i.test(String(d.taxon_status));
  let rec = arr.find(d => nameOf(d) === target && accepted(d)) || arr.find(d => nameOf(d) === target)
         || arr.find(d => synonymsOf(d).includes(target));
  if (!rec && zh) rec = arr.find(d => d.common_name_c === zh || String(d.alternative_name_c || '').split(/[,;，、]/).map(s => s.trim()).includes(zh));
  return rec || null;
}

function fromTaicol(rec) {
  const p = rec.protected ?? rec.protected_category ?? rec.conservation;
  const prot = String(p ?? '').trim() === '1' ? 'CHPA' : normProtected(p);
  return {
    protected: prot,
    protectedScope: prot ? 'species' : null,
    endemic: truthy(rec.is_endemic ?? rec.endemic),
    source: 'TaiCOL',
    id: rec.taxon_id || null,
  };
}

function pickTbn(body, sci, zh) {
  const arr = recordsOf(body);
  const target = bareName(sci);
  const nameOf = (d) => bareName(d.simplifiedScientificName || d.scientificName || d.taxonName || '');
  let rec = arr.find(d => nameOf(d) === target);
  if (!rec && zh) rec = arr.find(d => String(d.vernacularName || '').split(/[,;，、]/).map(s => s.trim()).includes(zh));
  return rec || null;
}

function fromTbn(rec) {
  let prot = normProtected(rec.protectedStatusTW);
  let scope = prot ? 'species' : null;
  if (!prot && Array.isArray(rec.children)) {
    const order = { I: 1, II: 2, III: 3, CHPA: 4 };
    const childLevels = rec.children.map(c => normProtected(c.protectedStatusTW)).filter(Boolean).sort((a, b) => order[a] - order[b]);
    if (childLevels.length) { prot = childLevels[0]; scope = 'subspecies'; }
  }
  return {
    protected: prot,
    protectedScope: scope,
    endemic: truthy(rec.endemism),
    source: 'TBN',
    id: rec.taiCOLTaxonID || rec.taiColNameCode || rec.taxonUUID || null,
  };
}

async function lookup(sci, zh, deadline, debug) {
  const trace = debug ? [] : null;
  const note = (q, r) => { if (trace) trace.push({ q, err: r.err || null, raw: r.data ? JSON.stringify(r.data).slice(0, 3000) : null }); };
  let result = null;
  let failed = false;   // 有名錄沒有回應（逾時、錯誤）：結果可能不完整

  // 1) TaiCOL：學名，查無再用中文俗名
  let tc = await fetchJson(`${TAICOL_API}?scientific_name=${encodeURIComponent(sci)}`, deadline);
  note('taicol:sci', tc);
  let rec = tc.data ? pickTaicol(tc.data, sci, zh) : null;
  if (!rec && zh && !tc.err) {
    tc = await fetchJson(`${TAICOL_API}?common_name=${encodeURIComponent(zh)}`, deadline);
    note('taicol:zh', tc);
    rec = tc.data ? pickTaicol(tc.data, sci, zh) : null;
  }
  if (tc.err) failed = true;
  if (rec) result = fromTaicol(rec);

  // 2) TBN：TaiCOL 查無、查詢失敗，或物種層級沒有保育等級時（可能以亞種列名）
  if (!result || !result.protected) {
    let tb = await fetchJson(`${TBN_API}?name=${encodeURIComponent(sci)}&withChildren=1`, deadline);
    note('tbn:sci', tb);
    let rb = tb.data ? pickTbn(tb.data, sci, zh) : null;
    if (!rb && zh && !tb.err) {
      tb = await fetchJson(`${TBN_API}?name=${encodeURIComponent(zh)}&withChildren=1`, deadline);
      note('tbn:zh', tb);
      rb = tb.data ? pickTbn(tb.data, sci, zh) : null;
    }
    if (tb.err) failed = true;
    if (rb) {
      const t = fromTbn(rb);
      if (!result) result = t;
      else {
        if (t.protected) { result.protected = t.protected; result.protectedScope = t.protectedScope; result.source = 'TaiCOL+TBN'; }
        if (result.endemic == null && t.endemic != null) result.endemic = t.endemic;
      }
    }
  }
  // 什麼都沒查到、且有名錄沒有回應 → 不回答，讓前端稍後再查；查到部分結果則回傳但不快取
  if (!result && failed) return { pending: true, trace };
  return { value: result || { protected: null, protectedScope: null, endemic: null, source: null, id: null }, transient: failed, trace };
}

export default async (request, context) => {
  const url = new URL(request.url);
  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || 'unknown';

  // 暫時偵錯（合併前移除）：GET ?debug=raw&host=taicol|tbn&<白名單參數> → 上游狀態碼、標頭與回應前段
  if (request.method === 'GET' && url.searchParams.get('debug') === 'raw') {
    if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);
    const host = url.searchParams.get('host');
    const base = host === 'tbn' ? TBN_API : TAICOL_API;
    const allow = ['taxon_group', 'rank', 'parent_taxon_id', 'scientific_name', 'common_name', 'is_in_taiwan', 'limit', 'taxon_id', 'name', 'withChildren', 'uuid'];
    const q = new URLSearchParams();
    for (const k of allow) if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k).slice(0, 80));
    const ua = url.searchParams.get('ua') === 'none' ? {} : { 'user-agent': UA };
    try {
      const res = await fetch(`${base}?${q}`, { headers: { ...ua, accept: url.searchParams.get('accept') || 'application/json' } });
      const text = await res.text();
      const h = {};
      for (const k of ['server', 'cf-ray', 'content-type', 'x-cache', 'via', 'www-authenticate']) if (res.headers.get(k)) h[k] = res.headers.get(k);
      return json({ status: res.status, headers: h, body: text.slice(0, 6000), length: text.length });
    } catch (e) {
      return json({ error: String(e && e.message || e) });
    }
  }

  // 偵錯：GET /api/taxon-status?debug=1&sci=…&zh=…（回傳上游原始回應片段，供調整解析規則）
  if (request.method === 'GET' && url.searchParams.get('debug') === '1') {
    if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);
    const sci = (url.searchParams.get('sci') || '').trim();
    const zh = (url.searchParams.get('zh') || '').trim();
    if (!SCI_RE.test(sci)) return json({ error: 'Bad scientific name' }, 400);
    const r = await lookup(sci, ZH_RE.test(zh) ? zh : '', Date.now() + TOTAL_TIMEOUT_MS, true);
    return json(r);
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

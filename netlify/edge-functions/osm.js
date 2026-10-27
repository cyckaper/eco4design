// 棲共生 · OSM Overpass 代查（Netlify Edge Function / Deno）
// 目的：讓 OSM 環境脈絡查詢走本站伺服器，而不是由瀏覽器直接打公用 Overpass 伺服器。
//
// 為什麼需要這一層（三個瀏覽器端做不到的事）：
//   1. 金鑰：overpass.ch 的金鑰寫在網址路徑裡（.../v1/<金鑰>/interpreter），
//      放進前端等於公開。存在伺服器端環境變數才能用，瀏覽器看不到。
//   2. 身分標示：Overpass 使用規範要求送出可識別的 User-Agent／Referer，
//      瀏覽器的 fetch 不允許設定 User-Agent，只有伺服器端做得到。
//   3. 共用快取：同一基地的重複查詢（整班分析同一處、來回調半徑）直接由本層回答，
//      不必每次都打上游。
//
// 請求：POST，與 Overpass 原生格式相同（Content-Type: application/x-www-form-urlencoded，
//       內容為 data=<Overpass QL>）。因此前端只需把網址換成 /api/osm，查詢字串仍由前端組
//       （bbox、標籤篩選維持單一來源，不會兩邊各寫一份而逐漸走樣）。
// 回應：上游的 JSON 原樣回傳，另加 x-osm-source（實際使用的上游主機名）與 x-osm-cache（hit/miss）。
//
// 上游順序：OVERPASS_ENDPOINT（選填，通常是帶金鑰的 overpass.ch）→ 公用伺服器。
//   任一台忙碌（429／5xx／逾時／回傳非 JSON）就換下一台；全部失敗才回 503。
//
// 選填環境變數：
//   OVERPASS_ENDPOINT  完整的 interpreter 網址，例如 https://api.overpass.ch/v1/<金鑰>/interpreter
//                      未設定時只用公用伺服器（仍可運作，只是沒有專屬額度）。
// 不需通行碼（OSM 面板在輸入通行碼之前就會顯示）；以查詢格式檢查、大小上限與 IP 速率限制防止被當成公開代理濫用。

const MAX_BODY_BYTES = 8 * 1024;        // Overpass QL 查詢；本站產生的約 0.8 KB

// Netlify Edge Function 必須在 40 秒內送出回應標頭，否則整個函式被平台中止（前端收到 500）。
// 因此所有嘗試共用一個總預算：預算用完就立刻回 503，由前端自行改試公用伺服器。
// 提早放棄比硬撐好，原因有二：被平台中止時白等近 40 秒，而且 500 不帶任何診斷資訊。
// 這個設計也讓「快速失敗」與「慢速失敗」得到不同待遇——
// 上游若秒回 429／503，預算幾乎沒消耗，還能多試幾台；
// 上游若卡住不回，預算被吃掉，就不再試下一台，直接把棒子交回前端（前端自己也有三台備援）。
const TOTAL_BUDGET_MS = 30000;          // 全部嘗試合計上限（距平台的 40 秒留足安全邊際）
const RESPONSE_RESERVE_MS = 1500;       // 保留給解析與回傳，不計入上游等待
const MIN_ATTEMPT_MS = 6000;            // 剩餘預算不足此值就不開始新的嘗試
// 單一上游上限。設成容得下上游查詢本身的 25 秒，是實測得來的：
// 2026-10-27 公用伺服器壅塞時，overpass-api.de 花了 25.1 秒才回，但確實回了正確資料。
// 曾經想「公用伺服器卡住就早點放棄、省下預算多試一台」，實測證明那是錯的——
// 早放棄等於砍掉一條本來會成功的路，而前端接手後又要重等一次，使用者總共等更久。
const UPSTREAM_TIMEOUT_MS = 26000;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // OSM 的林相、水體、步道不會以小時為單位變動
const CACHE_MAX = 300;
const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 120;  // 同一來源 IP 每 5 分鐘最多 120 次（教室共用一個對外 IP 時也夠用）
const RETRY_503_MS = 1500;              // overpass.ch 免費方案查詢槽滿時回 503，官方說明要求稍候重試

// 公用伺服器（資料同為 OpenStreetMap）。overpass.ch 若有設定會排在這些之前。
const PUBLIC_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const SITE = 'https://eco4design.healsdesign.org';
const UA = `Qi-Coexistence-OSM/1.0 (+${SITE})`;

const cache = new Map();   // 查詢字串 → { at, body }
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
  if (rate.size > 2000) { for (const k of rate.keys()) { rate.delete(k); if (rate.size <= 1500) break; } }
  return list.length > RATE_MAX;
}

function cacheGet(q) {
  const hit = cache.get(q);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(q); return null; }
  cache.delete(q); cache.set(q, hit);   // 最近使用的排到最後
  return hit.body;
}

function cacheSet(q, body) {
  cache.set(q, { at: Date.now(), body });
  if (cache.size > CACHE_MAX) { for (const k of cache.keys()) { cache.delete(k); if (cache.size <= CACHE_MAX) break; } }
}

// 只接受本站產生的那種查詢：JSON 輸出、有逾時上限、長度合理。
// 不是為了防堵所有惡意輸入，而是避免這個端點被當成任意查詢的公開代理。
function invalidQuery(q) {
  if (!q || q.length < 20) return 'empty or too short';
  if (!q.includes('[out:json]')) return 'not a JSON-output Overpass query';
  if (!/\[timeout:\s*\d{1,3}\]/.test(q)) return 'missing timeout limit';
  const t = Number((q.match(/\[timeout:\s*(\d{1,3})\]/) || [])[1]);
  if (!(t > 0 && t <= 60)) return 'timeout out of range';
  return null;
}

// 這一次嘗試能等多久：單台上限與剩餘總預算取小者。
// 回傳 null 表示預算已不足，不該再開始新的嘗試。
function attemptBudget(deadline) {
  const budget = Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now() - RESPONSE_RESERVE_MS);
  return budget >= MIN_ATTEMPT_MS ? budget : null;
}

async function attemptOnce(url, query, budgetMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), budgetMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        'referer': SITE,
        'accept': 'application/json',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: ac.signal,
    });

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) {}
      return { ok: false, status: res.status, detail };
    }

    // Overpass 忙碌時偶爾以 HTTP 200 回傳 HTML 錯誤頁（而不是 JSON），
    // 直接當成功會讓前端解析失敗，所以在這裡識破並改用下一台。
    const text = await res.text();
    if (text.length > MAX_UPSTREAM_BYTES) return { ok: false, status: 502, detail: 'response too large' };
    let data;
    try { data = JSON.parse(text); }
    catch (_) { return { ok: false, status: 502, detail: 'upstream returned non-JSON (usually a busy/timeout page)' }; }
    if (!data || !Array.isArray(data.elements)) return { ok: false, status: 502, detail: 'upstream JSON has no elements' };
    return { ok: true, body: text };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
    return { ok: false, status: aborted ? 504 : 502, detail: aborted ? 'upstream timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function tryEndpoint(url, query, deadline) {
  const budget = attemptBudget(deadline);
  if (budget === null) return { ok: false, status: 504, detail: 'skipped: time budget exhausted', skipped: true };

  let out = await attemptOnce(url, query, budget);

  // overpass.ch 免費方案在查詢槽都忙碌時回 503，並要求稍候重試（而非換伺服器）。
  // 只在「等待 ＋ 一次最短嘗試」仍放得進剩餘預算時才重試。
  if (!out.ok && out.status === 503) {
    const retryBudget = attemptBudget(deadline - RETRY_503_MS);
    if (retryBudget !== null) {
      await new Promise(r => setTimeout(r, RETRY_503_MS));
      out = await attemptOnce(url, query, retryBudget);
    }
  }
  return out;
}

export default async (request, context) => {
  const startedAt = Date.now();   // 總時間預算的起點（見 TOTAL_BUDGET_MS）

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
      },
    });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ip = (context && context.ip) || request.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) return json({ error: 'Too many requests' }, 429);

  let raw;
  try { raw = await request.text(); } catch (_) { return json({ error: 'Cannot read request body' }, 400); }
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Query too large' }, 413);

  // 與 Overpass 原生介面一致：body 為 data=<查詢>；也接受直接送查詢本身。
  // 前端以 encodeURIComponent 編碼（空白為 %20），因此不把 '+' 視為空白，
  // 以免查詢中的正規表示式量詞（例如 [a-z]+）被改掉。
  let query = raw;
  if (/^data=/.test(raw)) {
    try { query = decodeURIComponent(raw.slice(5)); }
    catch (_) { return json({ error: 'Malformed body encoding' }, 400); }
  }

  const bad = invalidQuery(query);
  if (bad) return json({ error: `Rejected query: ${bad}` }, 400);

  const cached = cacheGet(query);
  if (cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'x-osm-cache': 'hit',
      },
    });
  }

  let endpoints = PUBLIC_ENDPOINTS;
  try {
    const custom = Deno.env.get('OVERPASS_ENDPOINT');
    if (custom && /^https:\/\//.test(custom)) endpoints = [custom, ...PUBLIC_ENDPOINTS];  // 帶金鑰的專屬端點優先
  } catch (_) {}

  const deadline = startedAt + TOTAL_BUDGET_MS;
  const attempts = [];
  for (const ep of endpoints) {
    let host = ep;
    try { host = new URL(ep).host; } catch (_) {}   // 只取主機名：金鑰在路徑裡，不可出現在回應或紀錄中
    const out = await tryEndpoint(ep, query, deadline);
    if (out.ok) {
      cacheSet(query, out.body);
      return new Response(out.body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'x-osm-source': host,
          'x-osm-cache': 'miss',
        },
      });
    }
    attempts.push({ endpoint: host, status: out.status, detail: out.detail });
    // 預算用完就不再往下試：剩下的交給前端自己的公用伺服器備援，
    // 這樣至少能在平台中止之前把帶診斷資訊的 503 送出去。
    if (out.skipped) break;
  }

  // 全部失敗：回報每一台的狀況（只含主機名）與耗時供診斷；前端會再自行改試公用伺服器
  return json({ error: 'All Overpass endpoints are unavailable', attempts, ms: Date.now() - startedAt }, 503,
    { 'access-control-allow-origin': '*' });
};

export const config = { path: '/api/osm' };

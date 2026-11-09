// 棲共生 · 植生與景觀結構（Sentinel-2 NDVI，10 m）
// 以基地點為中心，取 500 m、1 km、5 km、10 km 四個半徑，算近 12（或 24）個月
// 無雲像元的 NDVI 中位數合成，再算各半徑的植生覆蓋與景觀結構指標。
//
// 資料：Copernicus Sentinel-2 Level-2A（Collection 1）。經由 Earth Search（Element 84）的 STAC 查詢，
// 影像本身是 AWS 上的 Cloud-Optimized GeoTIFF，公開、不需金鑰、支援 HTTP Range。
// 2026-11-09 從 eco4design 實測：B04／B08 一個 1024×1024 全解析度 tile 平均 1.3 MB（最大 1.65 MB），
// SCL（20 m）tile 平均 13 KB；tile 在檔案裡不連續，所以一個 tile 一個 Range 請求。
//
// 為什麼在伺服器端做、而且放 Function 不放 Edge Function：
//   半徑 10 km 的視窗是 2000×2000 像元，每一景要抓 red、nir 各約 9 個 tile（約 23 MB），
//   8 景就是將近 190 MB——學生在野外用手機不可能下載這個量；Edge 每請求 50 ms CPU 也裝不下
//   解壓縮與中位數運算。Node 執行環境是秒級 CPU，而且 Netlify 與 S3 都在 AWS 上，頻寬夠。
//
// 為什麼不裝 geotiff.js：只需要「讀 IFD0 → 取 tile 位移表 → 抓幾個 tile → inflate → 還原 predictor」，
// 自己寫約 120 行，逾時、併發、預算都在自己手上；整個 repo 也只有一個相依套件（unpdf），不想再加。
//
// 為什麼是中位數、不是最大值：最大值合成偏向生長季、會把殘雲邊緣的異常值撿進來；
// 中位數對殘雲與陰影穩健，給的是這一年「典型」的綠度。景的挑法也為此：把期間分成四季，
// 每季取雲量最低的兩景（最多 8 景），不然臺灣的無雲景集中在冬天乾季，中位數會偏低。
//
// 誠實標示：NDVI 量的是綠色生物量，不是棲地品質；農地可以很綠。植生／密植生的門檻（0.2、0.5）
// 是通用值、不是在地校正過的分類；斑塊是依門檻切出來的，不是土地覆蓋圖。這些話跟著資料回傳，
// 前端放進提示詞與報告附錄。
//
// 請求（GET）：/api/ndvi?lat=&lon=&months=12|24
//   用 GET 是為了讓 Netlify 的 CDN 快取（Netlify-CDN-Cache-Control）接手：同一個基地、同一個月，
//   全班五十個人只算一次。期間取「本月 1 日往前 N 個月」，所以一個月內鍵值不變。
// 回應：見檔尾組裝處。

import { inflate as inflateCb, deflateSync } from 'node:zlib';
import { promisify } from 'node:util';

const inflate = promisify(inflateCb);

const STAC = 'https://earth-search.aws.element84.com/v1/search';
const COLLECTION = 'sentinel-2-c1-l2a';
const SITE = 'https://eco4design.healsdesign.org';
const UA = `Qi-Coexistence-NDVI/1.0 (+${SITE})`;

export const RADII_M = [500, 1000, 5000, 10000];
export const PIXEL_M = 10;
export const THRESHOLDS = { water: 0, veg: 0.2, dense: 0.5 };
const HALF_PX = RADII_M[RADII_M.length - 1] / PIXEL_M;     // 1000：視窗半寬（像元）
const WIN = HALF_PX * 2;                                     // 2000×2000

// SCL 類別：0 無資料、1 飽和或瑕疵、2 暗區、3 雲影、4 植生、5 無植生、6 水、7 未分類、
// 8 雲（中機率）、9 雲（高機率）、10 薄卷雲、11 雪。保留 2、4、5、6、7。
const SCL_OK = new Uint8Array(16); [2, 4, 5, 6, 7].forEach(c => { SCL_OK[c] = 1; });

const MAX_SCENES = 8;
const MAX_TILE_CLOUD = 70;         // 整景雲量上限（%）；局部的雲由 SCL 逐像元處理
const TOTAL_BUDGET_MS = 23000;     // 函式上限 26 秒，留時間給合成、指標與回傳
const FETCH_DEADLINE_MS = 12000;   // 這個時點之後不再開始抓新的景（線上實測：8 景抓完 15.7 s、合成與指標 6.6 s，總共 22.4 s 太貼近上限）
const SCENE_CONCURRENCY = 3;       // 每景約 22 個 Range 請求；線上實測兩景並行約 13 MB/s，三景並行多開連線把頻寬吃滿
const HEADER_BYTES = 65536;        // IFD0 與 tile 位移表通常在前 64 KB（實測 121 個 tile 的檔案都在）

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 40;
const cache = new Map();
const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 40;
const rate = new Map();

const ALLOWED_ORIGINS = ['*.healsdesign.org', 'eco4design.netlify.app', 'cyckaper.github.io'];
const DEV_HOSTNAMES = ['localhost', '127.0.0.1'];

export function originRejected(origin) {
  if (!origin) return null;
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

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── 期間：本月 1 日往前 N 個月（鍵值一個月內不變，CDN 快取才有用）──────────────
export function periodFor(months, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  const iso = d => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end), months };
}

// ── WGS84 ↔ UTM（Snyder 公式，誤差公分級；與 proj 的結果比對過）───────────────
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const E4 = E2 * E2, E6 = E4 * E2;
const M1 = 1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256;
const M2 = 3 * E2 / 8 + 3 * E4 / 32 + 45 * E6 / 1024;
const M3 = 15 * E4 / 256 + 45 * E6 / 1024;
const M4 = 35 * E6 / 3072;
const SQ1E2 = Math.sqrt(1 - E2);
const EI = (1 - SQ1E2) / (1 + SQ1E2);
const P2 = 3 * EI / 2 - 27 * EI ** 3 / 32 + 269 * EI ** 5 / 512;
const P3 = 21 * EI ** 2 / 16 - 55 * EI ** 4 / 32;
const P4 = 151 * EI ** 3 / 96 - 417 * EI ** 5 / 128;
const P5 = 1097 * EI ** 4 / 512;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

export function toUtm(lat, lon, zone, north) {
  const φ = rad(lat), λ = rad(lon), λ0 = rad((zone - 1) * 6 - 180 + 3);
  const sinφ = Math.sin(φ), cosφ = Math.cos(φ), tanφ = Math.tan(φ);
  const n = A / Math.sqrt(1 - E2 * sinφ * sinφ);
  const c = EP2 * cosφ * cosφ;
  const a = cosφ * (λ - λ0);
  const m = A * (M1 * φ - M2 * Math.sin(2 * φ) + M3 * Math.sin(4 * φ) - M4 * Math.sin(6 * φ));
  const t = tanφ * tanφ;
  const a2 = a * a, a3 = a2 * a, a4 = a3 * a, a5 = a4 * a, a6 = a5 * a;
  const x = K0 * n * (a + (1 - t + c) * a3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * EP2) * a5 / 120) + 500000;
  let y = K0 * (m + n * tanφ * (a2 / 2 + (5 - t + 9 * c + 4 * c * c) * a4 / 24 + (61 - 58 * t + t * t + 600 * c - 330 * EP2) * a6 / 720));
  if (!north) y += 10000000;
  return { x, y };
}

export function fromUtm(x, y, zone, north) {
  const xx = x - 500000, yy = north ? y : y - 10000000;
  const m = yy / K0, mu = m / (A * M1);
  const pRad = mu + P2 * Math.sin(2 * mu) + P3 * Math.sin(4 * mu) + P4 * Math.sin(6 * mu) + P5 * Math.sin(8 * mu);
  const sinP = Math.sin(pRad), cosP = Math.cos(pRad), tanP = sinP / cosP;
  const ep2 = EP2;
  const n = A / Math.sqrt(1 - E2 * sinP * sinP);
  const r = (1 - E2) / (1 - E2 * sinP * sinP);
  const c = ep2 * cosP * cosP, c2 = c * c;
  const d = xx / (n * K0), d2 = d * d, d3 = d2 * d, d4 = d3 * d, d5 = d4 * d, d6 = d5 * d;
  const t = tanP * tanP, t2 = t * t;
  const lat = pRad - (tanP / r) * (d2 / 2 - d4 / 24 * (5 + 3 * t + 10 * c - 4 * c2 - 9 * ep2)
    + d6 / 720 * (61 + 90 * t + 298 * c + 45 * t2 - 252 * ep2 - 3 * c2));
  const lon = (d - d3 / 6 * (1 + 2 * t + c) + d5 / 120 * (5 - 2 * c + 28 * t - 3 * c2 + 8 * ep2 + 24 * t2)) / cosP;
  return { lat: deg(lat), lon: deg(lon) + ((zone - 1) * 6 - 180 + 3) };
}

// ── 最小 COG 讀取：IFD0、tile 表、抓需要的 tile、inflate、還原 predictor ────────
// 只支援這些 Sentinel-2 COG 實際用到的設定：tile 排列、deflate（8）、predictor 1 或 2、
// 單一波段、uint16 或 uint8、classic 或 BigTIFF、little-endian。其他一律報錯而不是猜。
async function fetchRange(url, from, to, signal) {
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}`, 'user-agent': UA }, signal });
  if (res.status !== 206 && res.status !== 200) throw new Error(`http_${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // 伺服器不理 Range 而回整個檔（200）時，自己切；S3 一向回 206，這裡只是保險
  return res.status === 200 && buf.length > to - from + 1 ? buf.subarray(from, to + 1) : buf;
}

export function parseIfd0(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== 0x4949) throw new Error('cog: big-endian TIFF not supported');
  const magic = dv.getUint16(2, true);
  const big = magic === 43;
  if (!big && magic !== 42) throw new Error('cog: not a TIFF');
  let off = big ? Number(dv.getBigUint64(8, true)) : dv.getUint32(4, true);
  const n = big ? Number(dv.getBigUint64(off, true)) : dv.getUint16(off, true);
  const es = big ? 20 : 12;
  const start = off + (big ? 8 : 2);
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 16: 8 };
  const tags = {};
  for (let i = 0; i < n; i++) {
    const p = start + i * es;
    const tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true);
    const cnt = big ? Number(dv.getBigUint64(p + 4, true)) : dv.getUint32(p + 4, true);
    const vp = p + (big ? 12 : 8);
    const size = (TYPE_SIZE[type] || 0) * cnt;
    const inline = size <= (big ? 8 : 4);
    const at = inline ? vp : (big ? Number(dv.getBigUint64(vp, true)) : dv.getUint32(vp, true));
    tags[tag] = { type, cnt, at };
  }
  return { big, tags, dv };
}

const readArr = (dv, t, i) => t.type === 3 ? dv.getUint16(t.at + i * 2, true)
  : t.type === 4 ? dv.getUint32(t.at + i * 4, true)
  : t.type === 16 ? Number(dv.getBigUint64(t.at + i * 8, true))
  : t.type === 1 ? dv.getUint8(t.at + i) : NaN;

export async function cogHeader(url, signal) {
  let bytes = await fetchRange(url, 0, HEADER_BYTES - 1, signal);
  let h = parseIfd0(bytes);
  const need = Math.max(...[324, 325].map(k => { const t = h.tags[k]; return t ? t.at + t.cnt * ({ 3: 2, 4: 4, 16: 8 }[t.type] || 1) : 0; }));
  if (need > bytes.length) {                    // tile 表在 64 KB 之外（沒遇過，但要能處理）
    const more = await fetchRange(url, bytes.length, need - 1, signal);
    const joined = new Uint8Array(need); joined.set(bytes); joined.set(more, bytes.length);
    bytes = joined; h = parseIfd0(bytes);
  }
  const g = k => h.tags[k] ? readArr(h.dv, h.tags[k], 0) : undefined;
  const hdr = {
    width: g(256), height: g(257), bps: g(258), comp: g(259) || 1, spp: g(277) || 1,
    tileW: g(322), tileH: g(323), pred: g(317) || 1, fmt: g(339) || 1,
  };
  if (!hdr.tileW || !hdr.tileH) throw new Error('cog: not tiled');
  if (hdr.comp !== 8 && hdr.comp !== 32946 && hdr.comp !== 1) throw new Error('cog: compression ' + hdr.comp + ' not supported');
  if (hdr.spp !== 1 || (hdr.bps !== 16 && hdr.bps !== 8) || hdr.fmt !== 1) throw new Error('cog: only single-band uint8/uint16');
  if (hdr.pred !== 1 && hdr.pred !== 2) throw new Error('cog: predictor ' + hdr.pred + ' not supported');
  const to = h.tags[324], tb = h.tags[325];
  if (!to || !tb) throw new Error('cog: no tile table');
  hdr.tilesAcross = Math.ceil(hdr.width / hdr.tileW);
  hdr.tilesDown = Math.ceil(hdr.height / hdr.tileH);
  hdr.offsets = Array.from({ length: to.cnt }, (_, i) => readArr(h.dv, to, i));
  hdr.counts = Array.from({ length: tb.cnt }, (_, i) => readArr(h.dv, tb, i));
  return hdr;
}

// 讀一塊視窗（以該 COG 自己的像元座標計）到 out（Uint16Array 或 Uint8Array，大小 w×h）；
// 視窗超出影像的部分留 0（no data）。回傳實際讀到的 tile 數。
export async function readWindow(url, hdr, col0, row0, w, h, out, signal) {
  const bytesPer = hdr.bps === 16 ? 2 : 1;
  const tc0 = Math.max(0, Math.floor(col0 / hdr.tileW)), tc1 = Math.min(hdr.tilesAcross - 1, Math.floor((col0 + w - 1) / hdr.tileW));
  const tr0 = Math.max(0, Math.floor(row0 / hdr.tileH)), tr1 = Math.min(hdr.tilesDown - 1, Math.floor((row0 + h - 1) / hdr.tileH));
  const jobs = [];
  for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) jobs.push({ tr, tc, idx: tr * hdr.tilesAcross + tc });
  await Promise.all(jobs.map(async j => {
    const off = hdr.offsets[j.idx], cnt = hdr.counts[j.idx];
    if (!cnt) return;                                                   // 空 tile（沒有資料）：留 0
    const raw = await fetchRange(url, off, off + cnt - 1, signal);
    let data = hdr.comp === 1 ? raw : new Uint8Array((await inflate(raw)).buffer);
    const expected = hdr.tileW * hdr.tileH * bytesPer;
    if (data.length < expected) { const pad = new Uint8Array(expected); pad.set(data); data = pad; }
    let tile;
    if (bytesPer === 2) {
      if (data.byteOffset % 2) data = new Uint8Array(data);           // 對齊，否則 Uint16Array 會丟錯
      tile = new Uint16Array(data.buffer, data.byteOffset, hdr.tileW * hdr.tileH);
    } else tile = data;
    if (hdr.pred === 2) {                                               // 水平差分：逐列累加
      for (let r = 0; r < hdr.tileH; r++) {
        const b = r * hdr.tileW;
        for (let c = 1; c < hdr.tileW; c++) tile[b + c] = (tile[b + c] + tile[b + c - 1]) & (bytesPer === 2 ? 0xffff : 0xff);
      }
    }
    // 複製與視窗相交的部分
    const tileCol0 = j.tc * hdr.tileW, tileRow0 = j.tr * hdr.tileH;
    const cA = Math.max(col0, tileCol0), cB = Math.min(col0 + w, tileCol0 + hdr.tileW, hdr.width);
    const rA = Math.max(row0, tileRow0), rB = Math.min(row0 + h, tileRow0 + hdr.tileH, hdr.height);
    if (cB <= cA || rB <= rA) return;
    for (let r = rA; r < rB; r++) {
      const src = (r - tileRow0) * hdr.tileW + (cA - tileCol0);
      out.set(tile.subarray(src, src + (cB - cA)), (r - row0) * w + (cA - col0));
    }
  }));
  return jobs.length;
}

// ── STAC：找景、挑景 ────────────────────────────────────────────────────────
function inRing(ring, lon, lat) {                 // 射線法
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeometry(geom, lon, lat) {
  if (!geom) return false;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.some(rings => rings.length && inRing(rings[0], lon, lat) && !rings.slice(1).some(h => inRing(h, lon, lat)));
}

export async function searchScenes(lat, lon, period, signal) {
  const res = await fetch(STAC, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/geo+json', 'user-agent': UA },
    body: JSON.stringify({
      collections: [COLLECTION], limit: 200,
      intersects: { type: 'Point', coordinates: [lon, lat] },
      datetime: `${period.start}T00:00:00Z/${period.end}T00:00:00Z`,
      query: { 'eo:cloud_cover': { lt: MAX_TILE_CLOUD } },
      fields: { include: ['id', 'bbox', 'geometry', 'properties.datetime', 'properties.eo:cloud_cover', 'properties.grid:code',
        'properties.proj:epsg', 'properties.proj:code', 'properties.s2:processing_baseline', 'properties.s2:nodata_pixel_percentage',
        'assets.red', 'assets.nir', 'assets.scl'] },
    }),
  });
  if (!res.ok) throw new Error('stac_http_' + res.status);
  const body = await res.json();
  return Array.isArray(body && body.features) ? body.features : [];
}

// 選一個 MGRS 格（同一格的景才能疊在同一個像元網格上），再在期間內分季挑雲量最低的景
export function pickScenes(features, corners, maxScenes = MAX_SCENES) {
  const byGrid = new Map();
  for (const f of features) {
    const g = f.properties && f.properties['grid:code'];
    if (!g || !f.assets || !f.assets.red || !f.assets.nir || !f.assets.scl) continue;
    if (!byGrid.has(g)) byGrid.set(g, []);
    byGrid.get(g).push(f);
  }
  let best = null;
  for (const [grid, list] of byGrid) {
    // 四個視窗角落落在資料範圍內的數量（最多 4）：用幾何多邊形，部分格的資料範圍不是整個正方形
    const cover = list.reduce((m, f) => Math.max(m, corners.filter(([lo, la]) => inGeometry(f.geometry, lo, la)).length), 0);
    const score = cover * 1000 + Math.min(list.length, 999);
    if (!best || score > best.score) best = { grid, list, cover, score };
  }
  if (!best) return { grid: null, scenes: [], cover: 0, considered: features.length };
  const list = best.list.filter(f => {
    const nd = f.properties['s2:nodata_pixel_percentage'];
    return nd === undefined || nd === null || nd < 60;                  // 大半是空白的景跳過
  }).sort((a, b) => a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover']);
  // 分季（以日期的月份分 4 組）：一輪從每一季各取一景（季別依其最低雲量排序），
  // 不夠上限再取下一輪，所以 8 景大致是每季 2 景，2 景則是兩個不同季別中雲量最低的
  const bins = [[], [], [], []];
  for (const f of list) bins[Math.floor(new Date(f.properties.datetime).getUTCMonth() / 3)].push(f);
  const order = bins.filter(b => b.length).sort((a, b) => a[0].properties['eo:cloud_cover'] - b[0].properties['eo:cloud_cover']);
  const chosen = [];
  for (let round = 0; chosen.length < maxScenes && order.some(b => b.length > round); round++) {
    for (const b of order) { if (chosen.length >= maxScenes) break; if (b[round]) chosen.push(b[round]); }
  }
  const scenes = chosen.sort((a, b) => a.properties.datetime.localeCompare(b.properties.datetime));
  return { grid: best.grid, scenes, cover: best.cover, considered: features.length, inGrid: best.list.length };
}

// ── 一景：讀 red、nir（10 m）與 SCL（20 m），算 NDVI（int16 ×10000；-32768 = 無效）────
const NDVI_NA = -32768;
async function sceneNdvi(f, win, signal) {
  const [hRed, hNir, hScl] = await Promise.all([f.assets.red.href, f.assets.nir.href, f.assets.scl.href].map(u => cogHeader(u, signal)));
  if (hRed.width !== hNir.width || hRed.tileW !== hNir.tileW) throw new Error('cog: red/nir grids differ');
  const red = new Uint16Array(WIN * WIN), nir = new Uint16Array(WIN * WIN);
  // SCL 是 20 m：視窗座標除以 2（兩者同一原點，proj:transform 的 x0、y0 相同）
  const sw = Math.ceil(WIN / 2) + 1, sh = sw;
  const scl = new Uint8Array(sw * sh);
  const sc0 = Math.floor(win.col0 / 2), sr0 = Math.floor(win.row0 / 2);
  await Promise.all([
    readWindow(f.assets.red.href, hRed, win.col0, win.row0, WIN, WIN, red, signal),
    readWindow(f.assets.nir.href, hNir, win.col0, win.row0, WIN, WIN, nir, signal),
    readWindow(f.assets.scl.href, hScl, sc0, sr0, sw, sh, scl, signal),
  ]);
  const band = a => (a['raster:bands'] && a['raster:bands'][0]) || {};
  const sR = band(f.assets.red).scale ?? 0.0001, oR = band(f.assets.red).offset ?? 0;
  const sN = band(f.assets.nir).scale ?? 0.0001, oN = band(f.assets.nir).offset ?? 0;
  const out = new Int16Array(WIN * WIN).fill(NDVI_NA);
  let valid = 0;
  for (let r = 0; r < WIN; r++) {
    const srow = ((win.row0 + r) >> 1) - sr0;
    for (let c = 0; c < WIN; c++) {
      const i = r * WIN + c;
      const dr = red[i], dn = nir[i];
      if (!dr || !dn) continue;                                         // 0 = no data
      if (!SCL_OK[scl[srow * sw + (((win.col0 + c) >> 1) - sc0)]]) continue;
      const rr = Math.max(0, dr * sR + oR), nn = Math.max(0, dn * sN + oN);
      const sum = rr + nn;
      if (sum < 0.01) continue;                                         // 幾乎沒有訊號（深陰影、水面眩光後的 0）
      out[i] = Math.round((nn - rr) / sum * 10000);
      valid++;
    }
  }
  return { ndvi: out, valid };
}

// ── 合成：逐像元中位數 ───────────────────────────────────────────────────────
export function medianComposite(layers, n) {
  const med = new Int16Array(n).fill(NDVI_NA);
  const cnt = new Uint8Array(n);
  const L = layers.length;
  const tmp = new Int16Array(L);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let s = 0; s < L; s++) {
      const v = layers[s][i];
      if (v === NDVI_NA) continue;
      let j = k++;                                   // 插入排序：最多 8 個值，不配置任何物件
      while (j > 0 && tmp[j - 1] > v) { tmp[j] = tmp[j - 1]; j--; }
      tmp[j] = v;
    }
    if (!k) continue;
    med[i] = k & 1 ? tmp[k >> 1] : Math.round((tmp[(k >> 1) - 1] + tmp[k >> 1]) / 2);
    cnt[i] = k;
  }
  return { med, cnt };
}

// ── 景觀結構指標 ─────────────────────────────────────────────────────────────
// 圓內（像元中心到基地點 ≤ R）、有值的像元為景觀；斑塊 8 鄰接（FRAGSTATS 預設），
// 邊緣只算圓內兩個有值像元之間的類別交界（不算圓周、不算無資料邊）。
// 有效網目大小（effective mesh size, Jaeger 2000）＝ Σ 斑塊面積² ／ 景觀面積：
// 兩個隨機落點在同一斑塊的機率乘以景觀面積，越小表示越破碎。
export function landscapeMetrics(med, w, h, cx, cy, radiusPx, labels) {
  const r2 = radiusPx * radiusPx;
  const rmin = Math.max(0, Math.floor(cy - radiusPx) - 1), rmax = Math.min(h - 1, Math.ceil(cy + radiusPx) + 1);
  const cmin = Math.max(0, Math.floor(cx - radiusPx) - 1), cmax = Math.min(w - 1, Math.ceil(cx + radiusPx) + 1);
  const bw = cmax - cmin + 1, bh = rmax - rmin + 1;
  // 外接方框內的兩張遮罩（Lambda 的 CPU 約是本機的三分之一，逐像元呼叫閉包會把 10 km 那一圈拖到好幾秒）：
  //   inside：像元中心在圓內且有值；val：NDVI ×10000（圓外或無值為 NDVI_NA）
  const inside = new Uint8Array(bw * bh);
  const val = new Int16Array(bw * bh).fill(NDVI_NA);
  let nIn = 0, nValid = 0, sum = 0, water = 0, bare = 0, low = 0, dense = 0;
  const hist = new Int32Array(20001);                                 // NDVI ×10000 的直方圖，算分位數用
  const tW = Math.round(THRESHOLDS.water * 10000), tV = Math.round(THRESHOLDS.veg * 10000), tD = Math.round(THRESHOLDS.dense * 10000);
  for (let r = rmin; r <= rmax; r++) {
    const dy = r + 0.5 - cy, dy2 = dy * dy, rowOff = r * w, bOff = (r - rmin) * bw - cmin;
    for (let c = cmin; c <= cmax; c++) {
      const dx = c + 0.5 - cx;
      if (dx * dx + dy2 > r2) continue;
      nIn++;
      const v = med[rowOff + c];
      if (v === NDVI_NA) continue;
      inside[bOff + c] = 1; val[bOff + c] = v;
      nValid++; sum += v; hist[v + 10000]++;
      if (v < tW) water++; else if (v < tV) bare++; else if (v < tD) low++; else dense++;
    }
  }
  const haPerPx = (PIXEL_M * PIXEL_M) / 10000;
  const out = {
    r: Math.round(radiusPx * PIXEL_M), pixels: nIn, valid: nValid, validShare: nIn ? nValid / nIn : 0,
    areaHa: nValid * haPerPx, ndvi: null, classes: null, veg: null, dense: null,
  };
  if (!nValid) return out;
  const quantile = p => { let acc = 0; const target = p * nValid; for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc > target) return (i - 10000) / 10000; } return 1; };
  out.ndvi = { mean: sum / nValid / 10000, median: quantile(0.5), p10: quantile(0.1), p90: quantile(0.9) };
  out.classes = { water: water / nValid, bare: bare / nValid, low: low / nValid, dense: dense / nValid };
  // 斑塊（8 鄰接）與邊緣（4 鄰接的類別交界，兩邊都要在圓內且有值；從類別這一側數，每條只算一次）。
  // labels 只用外接方框的那一段（索引同 inside／val），大小夠：labels.length ≥ w*h ≥ bw*bh。
  const lab = labels.subarray(0, bw * bh);
  const stack = new Int32Array(bw * bh);
  const patchStats = thr => {
    lab.fill(0);
    let edge = 0, total = 0, largest = 0, sumSq = 0, nPatch = 0;
    for (let r = 0; r < bh; r++) {
      for (let c = 0; c < bw; c++) {
        const i = r * bw + c;
        if (!inside[i] || val[i] < thr) continue;
        // 右、下、左、上
        if (c + 1 < bw && inside[i + 1] && val[i + 1] < thr) edge++;
        if (r + 1 < bh && inside[i + bw] && val[i + bw] < thr) edge++;
        if (c > 0 && inside[i - 1] && val[i - 1] < thr) edge++;
        if (r > 0 && inside[i - bw] && val[i - bw] < thr) edge++;
        if (lab[i]) continue;
        const id = ++nPatch;
        let area = 0, sp = 0;
        lab[i] = id; stack[sp++] = i;
        while (sp) {
          const p = stack[--sp]; area++;
          const pr = (p / bw) | 0, pc = p - pr * bw;
          const r0 = pr > 0 ? pr - 1 : 0, r1 = pr + 1 < bh ? pr + 1 : bh - 1;
          const c0 = pc > 0 ? pc - 1 : 0, c1 = pc + 1 < bw ? pc + 1 : bw - 1;
          for (let nr = r0; nr <= r1; nr++) {
            const base = nr * bw;
            for (let nc = c0; nc <= c1; nc++) {
              const q = base + nc;
              if (lab[q] || !inside[q] || val[q] < thr) continue;
              lab[q] = id; stack[sp++] = q;
            }
          }
        }
        total += area; sumSq += area * area; if (area > largest) largest = area;
      }
    }
    const landscapeHa = nValid * haPerPx;
    return {
      share: total / nValid,
      patches: nPatch,
      meanHa: nPatch ? total * haPerPx / nPatch : 0,
      largestHa: largest * haPerPx,
      largestShare: largest / nValid,                                // largest patch index（佔景觀的比例）
      meshHa: landscapeHa ? sumSq * haPerPx * haPerPx / landscapeHa : 0,
      edgeMPerHa: landscapeHa ? edge * PIXEL_M / landscapeHa : 0,
      densityPer100Ha: landscapeHa ? nPatch / landscapeHa * 100 : 0,
    };
  };
  out.veg = patchStats(tV);
  out.dense = patchStats(tD);
  return out;
}

// ── 預覽圖：等經緯度網格的 8 位元調色盤 PNG（Leaflet imageOverlay 用經緯度邊界貼圖）────
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
// 調色盤：0 透明（圓外／視窗外）、1 無資料（淡灰）、2 水（藍）、3..63 由褐→黃→綠的 NDVI 色階
export const PALETTE_STEPS = 61;
function paletteRgb(i) {
  if (i === 1) return [200, 200, 200];
  if (i === 2) return [70, 130, 200];
  const t = (i - 3) / (PALETTE_STEPS - 1);                 // 0 → NDVI 0.0 ，1 → NDVI ≥ 0.8
  const stops = [[0, [166, 118, 70]], [0.25, [214, 190, 110]], [0.5, [150, 190, 90]], [0.75, [60, 140, 60]], [1, [16, 80, 30]]];
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, a] = stops[k - 1], [t1, b] = stops[k], u = (t - t0) / (t1 - t0);
      return a.map((v, j) => Math.round(v + (b[j] - v) * u));
    }
  }
  return stops[stops.length - 1][1];
}
export function encodePalettePng(idx, w, h) {
  const n = 3 + PALETTE_STEPS;
  const plte = new Uint8Array(n * 3), trns = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) { const [r, g, b] = i === 0 ? [0, 0, 0] : paletteRgb(i); plte.set([r, g, b], i * 3); }
  trns[0] = 0; trns[1] = 120;
  const raw = new Uint8Array((w + 1) * h);
  for (let r = 0; r < h; r++) { raw[r * (w + 1)] = 0; raw.set(idx.subarray(r * w, (r + 1) * w), r * (w + 1) + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))), chunk('IEND', new Uint8Array(0))];
  const len = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(len); let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return Buffer.from(png).toString('base64');
}
export const ndviToPaletteIndex = v => v === NDVI_NA ? 1 : v < 0 ? 2 : 3 + Math.min(PALETTE_STEPS - 1, Math.floor(Math.max(0, v / 10000) / 0.8 * (PALETTE_STEPS - 1)));

function buildPreview(med, win, zone, north, px, py, size = 384) {
  // 視窗四角的經緯度 → 邊界；每個預覽像元反投影到 UTM 再取最近的來源像元
  const corner = (c, r) => fromUtm(win.x0 + c * PIXEL_M, win.y0 - r * PIXEL_M, zone, north);
  const cs = [corner(0, 0), corner(WIN, 0), corner(0, WIN), corner(WIN, WIN)];
  const south = Math.min(...cs.map(p => p.lat)), north_ = Math.max(...cs.map(p => p.lat));
  const west = Math.min(...cs.map(p => p.lon)), east = Math.max(...cs.map(p => p.lon));
  const midLat = (south + north_) / 2;
  const W = size, H = Math.max(16, Math.round(size * (north_ - south) / ((east - west) * Math.cos(rad(midLat)))));
  const idx = new Uint8Array(W * H);
  const rOuter = RADII_M[RADII_M.length - 1] ** 2;
  for (let r = 0; r < H; r++) {
    const lat = north_ - (r + 0.5) / H * (north_ - south);
    for (let c = 0; c < W; c++) {
      const lon = west + (c + 0.5) / W * (east - west);
      const { x, y } = toUtm(lat, lon, zone, north);
      if ((x - px) ** 2 + (y - py) ** 2 > rOuter) continue;              // 圓外透明
      const sc = Math.floor((x - win.x0) / PIXEL_M), sr = Math.floor((win.y0 - y) / PIXEL_M);
      if (sc < 0 || sr < 0 || sc >= WIN || sr >= WIN) continue;
      idx[r * W + c] = ndviToPaletteIndex(med[sr * WIN + sc]);
    }
  }
  return { png: 'data:image/png;base64,' + encodePalettePng(idx, W, H), bounds: [[south, west], [north_, east]], width: W, height: H };
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
export async function analyze(lat, lon, months, { now = new Date(), budgetMs = TOTAL_BUDGET_MS, fetchDeadlineMs = FETCH_DEADLINE_MS, maxScenes = MAX_SCENES } = {}) {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const ac = new AbortController();
  // 抓取截止 4 秒後強制中止還沒抓完的景：合成、指標與預覽圖約需 2–3 秒，必須留在函式上限內
  const killer = setTimeout(() => ac.abort(), Math.min(budgetMs - 3000, fetchDeadlineMs + 4000));
  try {
    const period = periodFor(months, now);
    const features = await searchScenes(lat, lon, period, ac.signal);
    // 視窗四角（先用基地點的 UTM 帶估一個近似外框，只拿來挑 MGRS 格）
    const zoneGuess = Math.floor((lon + 180) / 6) + 1;
    const pg = toUtm(lat, lon, zoneGuess, lat >= 0);
    const R = RADII_M[RADII_M.length - 1];
    const corners = [[-R, -R], [R, -R], [-R, R], [R, R]].map(([dx, dy]) => { const p = fromUtm(pg.x + dx, pg.y + dy, zoneGuess, lat >= 0); return [p.lon, p.lat]; });
    const picked = pickScenes(features, corners, maxScenes);
    if (!picked.scenes.length) {
      return { error: 'no_scenes', zh: '這段期間內沒有雲量可用的 Sentinel-2 影像', period, considered: features.length };
    }
    const first = picked.scenes[0];
    const epsg = Number(first.properties['proj:epsg'] || String(first.properties['proj:code'] || '').replace(/^EPSG:/, ''));
    if (!(epsg >= 32601 && epsg <= 32760)) throw new Error('unexpected projection ' + epsg);
    const north = epsg < 32701, zone = epsg - (north ? 32600 : 32700);
    const tr = first.assets.red['proj:transform'];
    if (!Array.isArray(tr) || tr[0] !== PIXEL_M || tr[4] !== -PIXEL_M) throw new Error('unexpected red transform');
    const x0t = tr[2], y0t = tr[5];
    const p = toUtm(lat, lon, zone, north);
    const colP = (p.x - x0t) / PIXEL_M, rowP = (y0t - p.y) / PIXEL_M;
    const win = { col0: Math.round(colP) - HALF_PX, row0: Math.round(rowP) - HALF_PX };
    win.x0 = x0t + win.col0 * PIXEL_M; win.y0 = y0t - win.row0 * PIXEL_M;
    const cx = colP - win.col0, cy = rowP - win.row0;                 // 基地點在視窗內的像元座標（浮點）
    // 同一格內各景的網格一致；萬一不一致（不該發生）就跳過那景
    const sameGrid = f => { const t = f.assets.red['proj:transform']; return Array.isArray(t) && t[2] === x0t && t[5] === y0t; };

    const layers = [], used = [], skipped = [];
    let i = 0;
    const worker = async () => {
      while (i < picked.scenes.length) {
        const f = picked.scenes[i++];
        if (Date.now() > t0 + fetchDeadlineMs) { skipped.push({ id: f.id, why: 'time' }); continue; }
        if (!sameGrid(f)) { skipped.push({ id: f.id, why: 'grid' }); continue; }
        try {
          const { ndvi, valid } = await sceneNdvi(f, win, ac.signal);
          if (valid > 0) { layers.push(ndvi); used.push({ id: f.id, date: f.properties.datetime.slice(0, 10), cloud: f.properties['eo:cloud_cover'], validShare: valid / (WIN * WIN) }); }
          else skipped.push({ id: f.id, why: 'all_masked' });
        } catch (e) {
          const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
          skipped.push({ id: f.id, why: aborted ? 'time' : String(e && e.message || e).slice(0, 80) });
        }
      }
    };
    await Promise.all(Array.from({ length: SCENE_CONCURRENCY }, worker));
    if (!layers.length) {
      return { error: 'no_valid_pixels', zh: '抓到的影像在這個範圍內沒有無雲像元', period, scenes: used, skipped };
    }
    used.sort((a, b) => a.date.localeCompare(b.date));           // 併發完成的順序不是日期順序
    const tFetch = Date.now() - t0;
    const { med, cnt } = medianComposite(layers, WIN * WIN);
    layers.length = 0;
    const labels = new Int32Array(WIN * WIN);
    const radii = RADII_M.map(r => landscapeMetrics(med, WIN, WIN, cx, cy, r / PIXEL_M, labels));
    // 觀測次數：最外圈圓內的有值像元
    const rOut2 = HALF_PX * HALF_PX;
    const hist = new Uint32Array(maxScenes + 1);
    let nIn = 0;
    for (let r = 0; r < WIN; r++) for (let c = 0; c < WIN; c++) {
      const dy = r + 0.5 - cy, dx = c + 0.5 - cx;
      if (dx * dx + dy * dy > rOut2) continue;
      nIn++; hist[Math.min(maxScenes, cnt[r * WIN + c])]++;
    }
    let ge3 = 0; for (let k = 3; k <= maxScenes; k++) ge3 += hist[k];
    const preview = buildPreview(med, win, zone, north, p.x, p.y);
    const elapsed = Date.now() - t0;
    return {
      source: { collection: COLLECTION, grid: picked.grid, epsg, pixelM: PIXEL_M, stac: STAC,
        scenesConsidered: picked.considered, scenesInGrid: picked.inGrid, windowCornersInGrid: picked.cover },
      period, scenes: used, skipped,
      thresholds: THRESHOLDS,
      observations: { noData: nIn ? hist[0] / nIn : 0, ge3Share: nIn ? ge3 / nIn : 0, histogram: Array.from(hist) },
      radii, preview,
      notes: buildNotes(used.length, period),
      timing: { fetchMs: tFetch, totalMs: elapsed, overBudget: elapsed > deadline - t0 },
    };
  } finally {
    clearTimeout(killer);
  }
}

// 這段話會原樣顯示在介面與報告附錄；資料的性質要跟著資料一起走
function buildNotes(nScenes, period) {
  return [
    `NDVI 為 ${period.start}～${period.end} 期間 ${nScenes} 景 Sentinel-2 Level-2A 影像、經 SCL 雲遮罩後的逐像元中位數合成，像元 10 m。`,
    '植生（NDVI ≥ 0.2）與密植生（NDVI ≥ 0.5）是通用門檻，不是在地校正的土地覆蓋分類；農田、人工草坪也會被算成植生，密植生不等於天然林。',
    'NDVI 量的是綠色生物量與活力，不是棲地品質；斑塊是依門檻切出來的連續像元（8 鄰接），不是依土地利用或植群調查劃分。',
    '水域以 NDVI < 0 判定，會把陰影、裸露濕地一併算進去；山區陡坡的陰影也可能壓低 NDVI。',
    '半徑 500 m 與 1 km 說明基地及其周邊的綠量與破碎程度；5 km 與 10 km 說明基地所在的景觀基質，供活動範圍大的物種（猛禽、中大型哺乳類）與連結度討論使用。',
  ];
}

// ── HTTP ──────────────────────────────────────────────────────────────────
export default async (request, context) => {
  const startedAt = Date.now();
  const origin = request.headers.get('origin');
  const rejected = originRejected(origin);
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ndvi-cache' };
  if (request.method === 'OPTIONS') {
    if (rejected) return json(403, { error: 'Origin not allowed', origin: rejected });
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' } });
  }
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' }, cors);
  if (rejected) return json(403, { error: 'Origin not allowed', origin: rejected }, cors);
  const ip = (context && context.ip) || request.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (rateLimited(ip)) return json(429, { error: 'Too many requests' }, cors);

  const q = Object.fromEntries(new URL(request.url).searchParams.entries());
  const lat = num(q.lat), lon = num(q.lon);
  const months = q.months === '24' ? 24 : 12;
  if (lat === null || lat < -80 || lat > 80) return json(400, { error: 'lat out of range (-80..80)' }, cors);
  if (lon === null || lon < -180 || lon > 180) return json(400, { error: 'lon out of range' }, cors);

  // 四位小數（約 11 m）當鍵：微調基地點不該讓快取失效
  const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${months}|${periodFor(months).start}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key); cache.set(key, hit);
    return json(200, { ...hit.body, cache: 'hit', ms: Date.now() - startedAt }, { ...cors, 'x-ndvi-cache': 'hit', ...cdnCache() });
  }
  let body;
  try {
    body = await analyze(+lat.toFixed(4), +lon.toFixed(4), months);
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
    return json(aborted ? 504 : 502, {
      error: aborted ? 'Satellite data did not arrive within the time budget' : 'Upstream error: ' + String(e && e.message || e).slice(0, 120),
      zh: aborted ? '衛星影像在時間內沒有抓完，請再試一次（第二次通常較快）' : '衛星影像服務暫時無法使用',
      ms: Date.now() - startedAt,
    }, cors);
  }
  if (body.error) return json(404, { ...body, ms: Date.now() - startedAt }, cors);
  body.cache = 'miss'; body.ms = Date.now() - startedAt;
  // 景數夠才進快取（少於 3 景多半是暫時的逾時，快取下來等於讓這個基地一整天都只拿到殘缺的合成）
  if (body.scenes.length >= 3) {
    cache.set(key, { at: Date.now(), body });
    if (cache.size > CACHE_MAX) { for (const k of cache.keys()) { cache.delete(k); if (cache.size <= CACHE_MAX) break; } }
    return json(200, body, { ...cors, 'x-ndvi-cache': 'miss', ...cdnCache() });
  }
  return json(200, body, { ...cors, 'x-ndvi-cache': 'miss' });
};

// Netlify CDN：同一個 lat/lon/months 的 GET 在邊緣快取一天（期間鍵一個月才變），函式只算一次
function cdnCache() {
  return {
    'cache-control': 'public, max-age=3600',
    'netlify-cdn-cache-control': 'public, max-age=86400, durable',
    'netlify-vary': 'query=lat|lon|months',
  };
}

export const config = { path: '/api/ndvi' };

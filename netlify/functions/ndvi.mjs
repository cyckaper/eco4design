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
// 是通用值、不是在地校正過的分類；塊區是依門檻切出來的，不是土地覆蓋圖。這些話跟著資料回傳，
// 前端放進提示詞與報告附錄。
//
// 塊區（patch）是「同一類」的連續區域：水體、無植生／人工鋪面、低植生、密植生四類各自切塊、各自算指標，
// 不同類型不合併（2026-11-10 起；之前把 ≥0.2 的低植生與密植生合成一個「植生」類一起算）。
//
// 跨圖幅拼接（2026-11-15 起）：Sentinel-2 圖幅 109.8 km 見方、彼此只重疊 9.8 km，而 10 km 半徑的視窗是 20 km 見方，
// 基地離圖幅邊不到 10 km 時視窗必然跨到相鄰圖幅。之前只讀一個圖幅，跨出去的部分整片沒有資料（嘉義太保一帶的基地，
// 北邊約三分之一是空的）。現在把同一天、同一軌道、同一 UTM 帶的相鄰圖幅拼成一景：同一帶的圖幅原點都是 20 m 的倍數，
// 10 m 與 20 m 格網彼此對齊，直接拼、不重新取樣；不同 UTM 帶的格網互相旋轉，不混用（挑一個能涵蓋整個視窗、要拼的圖幅最少的帶）。
//
// 請求（GET）：/api/ndvi?lat=&lon=&months=12|24&v=3
//   v 是回應格式版本（CDN 快取鍵的一部分）：格式改變時前端換 v，舊的快取就不會再被拿到
//   （v=3：跨圖幅拼接、預覽圖改為 10 m 原解析度；v=2：塊區依覆蓋類型分開）
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

const MAX_SCENES = 8;               // 最多幾景；一景＝一個日期（同一天、同一軌道涵蓋視窗的圖幅拼在一起）
const MAX_TILE_CLOUD = 70;         // 整景雲量上限（%）；局部的雲由 SCL 逐像元處理
const MIN_DATE_COVERAGE = 0.2;     // 一個日期的資料至少要涵蓋 10 km 圓的兩成才考慮（只擦到一角的不值得讀）
const STAC_LIMIT = 1000;           // 一頁的上限：視窗跨兩個 UTM 帶、各兩個圖幅時，兩年約 470 景，一頁就夠
const STAC_MAX_PAGES = 3;
const SAMPLE_N = 21;               // 估涵蓋用的取樣格 21×21（間距 1 km），落在 10 km 圓內約 317 點
const BLOCK_GUESS = 1024;          // 排拼接順序時假設的 COG tile 邊長（Earth Search 的 10 m 波段實測如此；只影響效率，不影響結果）
const PREVIEW_PIXEL_M = 10;        // 預覽圖像元：與分析同為 10 m（2026-11-15 前是寬 384 像元、約 52 m，放大看很糊）
const PREVIEW_MAX_PX = 2400;
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

// 抓一個 COG tile、inflate、還原 predictor
async function decodeTile(url, hdr, idx, signal) {
  const bytesPer = hdr.bps === 16 ? 2 : 1;
  const off = hdr.offsets[idx], cnt = hdr.counts[idx];
  const raw = await fetchRange(url, off, off + cnt - 1, signal);
  let data = hdr.comp === 1 ? raw : new Uint8Array((await inflate(raw)).buffer);
  const expected = hdr.tileW * hdr.tileH * bytesPer;
  if (data.length < expected) { const pad = new Uint8Array(expected); pad.set(data); data = pad; }
  let tile;
  if (bytesPer === 2) {
    if (data.byteOffset % 2) data = new Uint8Array(data);             // 對齊，否則 Uint16Array 會丟錯
    tile = new Uint16Array(data.buffer, data.byteOffset, hdr.tileW * hdr.tileH);
  } else tile = data;
  if (hdr.pred === 2) {                                                 // 水平差分：逐列累加
    for (let r = 0; r < hdr.tileH; r++) {
      const b = r * hdr.tileW;
      for (let c = 1; c < hdr.tileW; c++) tile[b + c] = (tile[b + c] + tile[b + c - 1]) & (bytesPer === 2 ? 0xffff : 0xff);
    }
  }
  return tile;
}

// 讀一塊視窗（以該 COG 自己的像元座標計）到 out（Uint16Array 或 Uint8Array）；視窗超出影像的部分不寫
// （呼叫端的陣列預設是 0＝no data）。回傳涉及的 tile 數。
//   dst：寫到 out 的哪裡（預設 out 就是 w×h）。拼接相鄰圖幅時，每個圖幅只負責視窗的一塊，寫進同一張陣列。
//   blocks：同一圖幅的幾塊用到同一個 COG tile 時只抓一次（url#index → 解好的 tile）。
export async function readWindow(url, hdr, col0, row0, w, h, out, signal, dst = null, blocks = null) {
  const stride = dst ? dst.stride : w, ox = dst ? dst.x : 0, oy = dst ? dst.y : 0;
  const tc0 = Math.max(0, Math.floor(col0 / hdr.tileW)), tc1 = Math.min(hdr.tilesAcross - 1, Math.floor((col0 + w - 1) / hdr.tileW));
  const tr0 = Math.max(0, Math.floor(row0 / hdr.tileH)), tr1 = Math.min(hdr.tilesDown - 1, Math.floor((row0 + h - 1) / hdr.tileH));
  const jobs = [];
  for (let tr = tr0; tr <= tr1; tr++) for (let tc = tc0; tc <= tc1; tc++) jobs.push({ tr, tc, idx: tr * hdr.tilesAcross + tc });
  await Promise.all(jobs.map(async j => {
    if (!hdr.counts[j.idx]) return;                                     // 空 tile（沒有資料）：留 0
    let p = blocks && blocks.get(url + '#' + j.idx);
    if (!p) { p = decodeTile(url, hdr, j.idx, signal); if (blocks) blocks.set(url + '#' + j.idx, p); }
    const tile = await p;
    // 複製與視窗相交的部分
    const tileCol0 = j.tc * hdr.tileW, tileRow0 = j.tr * hdr.tileH;
    const cA = Math.max(col0, tileCol0), cB = Math.min(col0 + w, tileCol0 + hdr.tileW, hdr.width);
    const rA = Math.max(row0, tileRow0), rB = Math.min(row0 + h, tileRow0 + hdr.tileH, hdr.height);
    if (cB <= cA || rB <= rA) return;
    for (let r = rA; r < rB; r++) {
      const src = (r - tileRow0) * hdr.tileW + (cA - tileCol0);
      out.set(tile.subarray(src, src + (cB - cA)), (r - row0 + oy) * stride + (cA - col0 + ox));
    }
  }));
  return jobs.length;
}

// ── STAC：找景 ──────────────────────────────────────────────────────────────
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

// 查與整個視窗相交的景（不是只查基地那一點：相鄰圖幅只蓋到視窗一部分，也要找出來）。
// 臺灣常同時有 50、51 兩個 UTM 帶、各兩個圖幅，兩年約 470 景。每景二十幾個資產只要 red、nir、scl，
// 其餘用 fields.exclude 拿掉（每景約 2 KB，不拿掉約 14 KB）；整頁滿了才翻下一頁。
const ASSET_EXCLUDE = ['aot', 'blue', 'cloud', 'coastal', 'granule_metadata', 'green', 'nir08', 'nir09', 'preview', 'product_metadata',
  'rededge1', 'rededge2', 'rededge3', 'snow', 'swir16', 'swir22', 'thumbnail', 'tileinfo_metadata', 'visual', 'wvp'];
export async function searchScenes(ring, period, signal) {
  let body = {
    collections: [COLLECTION], limit: STAC_LIMIT,
    intersects: { type: 'Polygon', coordinates: [ring] },
    datetime: `${period.start}T00:00:00Z/${period.end}T00:00:00Z`,
    query: { 'eo:cloud_cover': { lt: MAX_TILE_CLOUD } },
    fields: {
      include: ['id', 'geometry', 'properties.datetime', 'properties.eo:cloud_cover', 'properties.grid:code', 'properties.proj:epsg', 'properties.proj:code',
        'properties.s2:processing_baseline', 'properties.s2:nodata_pixel_percentage', 'properties.sat:relative_orbit', 'assets.red', 'assets.nir', 'assets.scl'],
      exclude: ['links', 'bbox', 'stac_extensions', 'stac_version', 'collection', ...ASSET_EXCLUDE.map(k => 'assets.' + k),
        ...['red', 'nir', 'scl'].flatMap(b => [`assets.${b}.file:checksum`, `assets.${b}.eo:bands`])],
    },
  };
  const out = [];
  for (let page = 0; page < STAC_MAX_PAGES; page++) {
    const res = await fetch(STAC, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'application/geo+json', 'user-agent': UA },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('stac_http_' + res.status);
    const j = await res.json();
    const feats = Array.isArray(j && j.features) ? j.features : [];
    out.push(...feats);
    // Earth Search 的下一頁：POST，body 是完整的查詢加上 next 權杖（merge: false）
    const next = feats.length >= STAC_LIMIT && Array.isArray(j.links) ? j.links.find(l => l && l.rel === 'next' && l.body) : null;
    if (!next) break;
    body = next.merge ? { ...body, ...next.body } : next.body;
  }
  return out;
}

// 10 km 圓內的取樣點（經緯度），估各圖幅、各日期涵蓋多少
export function circleSamples(pg, zone, north, R, n = SAMPLE_N) {
  const pts = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const dx = (i / (n - 1) * 2 - 1) * R, dy = (j / (n - 1) * 2 - 1) * R;
    if (dx * dx + dy * dy > R * R * (1 + 1e-9)) continue;
    const q = fromUtm(pg.x + dx, pg.y + dy, zone, north);
    pts.push([q.lon, q.lat]);
  }
  return pts;
}

export function epsgOf(f) {
  const p = (f && f.properties) || {};
  const e = Number(p['proj:epsg'] || String(p['proj:code'] || '').replace(/^EPSG:/, ''));
  return e >= 32601 && e <= 32760 ? e : null;
}
export const tileName = f => String((f && f.properties && f.properties['grid:code']) || '').replace(/^MGRS-/, '') || String(f && f.id || '');

// ── 挑景：選 UTM 帶、把同一天的相鄰圖幅併成一景、分季挑日期 ──────────────────
// 1. UTM 帶：帶內所有圖幅聯集的涵蓋率最高者；一樣高時，要拼的圖幅少的（讀得少）、基地所在的標準帶、景多的優先。
// 2. 日期：同一天、同一軌道的圖幅是同一次拍攝，併成一景；同一天同一圖幅有兩筆（重新處理）時留涵蓋多、空白少的。
//    每景的涵蓋率＝圓內取樣點落在任一圖幅資料範圍內的比例；雲量＝各取樣點所屬圖幅雲量的平均（圖幅雲量各自不同）。
// 3. 分季：依月份分四季，每一輪從每一季各取剩下分數最好的一景；分數＝雲量 + (1 − 涵蓋率) × 100，
//    涵蓋不完整的日期往後排，涵蓋不到兩成的不考慮。
export function planScenes(features, samples, { maxScenes = MAX_SCENES, preferZone = null, minCoverage = MIN_DATE_COVERAGE } = {}) {
  const S = samples.length || 1;
  const ok = features.filter(f => f && f.properties && typeof f.properties.datetime === 'string' && f.assets && f.assets.red && f.assets.nir && f.assets.scl
    && Array.isArray(f.assets.red['proj:transform']) && epsgOf(f));
  const cov = new Map();
  for (const f of ok) {
    const m = new Uint8Array(samples.length); let k = 0;
    for (let i = 0; i < samples.length; i++) if (inGeometry(f.geometry, samples[i][0], samples[i][1])) { m[i] = 1; k++; }
    cov.set(f, { m, k });
  }
  const zones = new Map();
  for (const f of ok) { const e = epsgOf(f); if (!zones.has(e)) zones.set(e, []); zones.get(e).push(f); }
  let best = null;
  for (const [epsg, list] of zones) {
    const union = new Uint8Array(samples.length);
    const tiles = new Map();
    for (const f of list) {
      const t = tileName(f), m = cov.get(f).m;
      if (!tiles.has(t)) tiles.set(t, new Uint8Array(samples.length));
      const tm = tiles.get(t);
      for (let i = 0; i < m.length; i++) if (m[i]) { union[i] = 1; tm[i] = 1; }
    }
    let n = 0; for (const v of union) n += v;
    // 貪婪集合覆蓋：最少要拼幾個圖幅
    const left = union.slice(); let need = 0;
    for (;;) {
      let pick = null, gain = 0;
      for (const tm of tiles.values()) { let g = 0; for (let i = 0; i < left.length; i++) if (left[i] && tm[i]) g++; if (g > gain) { gain = g; pick = tm; } }
      if (!pick) break;
      need++; for (let i = 0; i < left.length; i++) if (pick[i]) left[i] = 0;
    }
    const cand = { epsg, zone: epsg % 100, north: epsg < 32700, list, coverage: n / S, need };
    const same = x => Math.abs(x.coverage - cand.coverage) < 1e-9;
    const better = !best || cand.coverage > best.coverage + 1e-9
      || (same(best) && (cand.need < best.need
        || (cand.need === best.need && ((cand.zone === preferZone) !== (best.zone === preferZone) ? cand.zone === preferZone : cand.list.length > best.list.length))));
    if (better) best = cand;
  }
  if (!best) return { epsg: null, dates: [], coverage: 0, grids: [], considered: features.length, inZone: 0, datesInZone: 0 };

  const groups = new Map();
  for (const f of best.list) {
    const date = f.properties.datetime.slice(0, 10);
    const key = date + '/' + (f.properties['sat:relative_orbit'] ?? '');
    if (!groups.has(key)) groups.set(key, { date, byTile: new Map() });
    const g = groups.get(key), t = tileName(f), prev = g.byTile.get(t);
    const nd = x => +(x.properties['s2:nodata_pixel_percentage'] ?? 0);
    if (!prev || cov.get(f).k > cov.get(prev).k || (cov.get(f).k === cov.get(prev).k && nd(f) < nd(prev))) g.byTile.set(t, f);
  }
  const all = [];
  for (const g of groups.values()) {
    const items = [...g.byTile.values()].sort((a, b) => cov.get(b).k - cov.get(a).k || tileName(a).localeCompare(tileName(b)));
    let covered = 0, cloudSum = 0;
    for (let i = 0; i < samples.length; i++) {
      const f = items.find(x => cov.get(x).m[i]);
      if (!f) continue;
      covered++; cloudSum += +f.properties['eo:cloud_cover'] || 0;
    }
    const coverage = covered / S;
    if (!covered || coverage < minCoverage) continue;
    const cloud = cloudSum / covered;
    all.push({ date: g.date, items, coverage, cloud, score: cloud + (1 - coverage) * 100 });
  }
  all.sort((a, b) => a.score - b.score || a.date.localeCompare(b.date));
  const bins = [[], [], [], []];
  for (const d of all) bins[Math.floor((+d.date.slice(5, 7) - 1) / 3)].push(d);
  const order = bins.filter(b => b.length).sort((a, b) => a[0].score - b[0].score);
  const chosen = [];
  for (let round = 0; chosen.length < maxScenes && order.some(b => b.length > round); round++) {
    for (const b of order) { if (chosen.length >= maxScenes) break; if (b[round]) chosen.push(b[round]); }
  }
  chosen.sort((a, b) => a.date.localeCompare(b.date));
  return {
    epsg: best.epsg, zone: best.zone, north: best.north, dates: chosen, coverage: best.coverage, tilesNeeded: best.need,
    grids: [...new Set(chosen.flatMap(d => d.items.map(tileName)))].sort(),
    considered: features.length, inZone: best.list.length, datesInZone: all.length,
  };
}

// ── 一景的讀取計畫：每個圖幅負責「視窗 ∩ 圖幅範圍 − 前面圖幅已負責的部分」──────────
// 視窗與圖幅都用像元座標（視窗左上角為 0）。同一次拍攝的相鄰圖幅，空白（軌道邊緣）的位置相同，
// 所以前面圖幅範圍內的像元不必再從後面的圖幅讀。順序影響要抓幾個 COG tile，圖幅不超過五個時全部排列試一次。
function rectMinus(a, b) {
  if (b.c1 <= a.c0 || b.c0 >= a.c1 || b.r1 <= a.r0 || b.r0 >= a.r1) return [a];
  const out = [];
  if (b.r0 > a.r0) out.push({ c0: a.c0, r0: a.r0, c1: a.c1, r1: b.r0 });
  if (b.r1 < a.r1) out.push({ c0: a.c0, r0: b.r1, c1: a.c1, r1: a.r1 });
  const r0 = Math.max(a.r0, b.r0), r1 = Math.min(a.r1, b.r1);
  if (b.c0 > a.c0) out.push({ c0: a.c0, r0, c1: b.c0, r1 });
  if (b.c1 < a.c1) out.push({ c0: b.c1, r0, c1: a.c1, r1 });
  return out;
}
function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [x, ...p]));
}
export function mosaicPlan(items, win) {
  const skipped = [];
  const cand = [];
  for (const f of items) {
    const tr = f.assets.red['proj:transform'], ts = f.assets.scl['proj:transform'], tn = f.assets.nir['proj:transform'];
    const shape = f.assets.red['proj:shape'];
    const rows = Array.isArray(shape) ? shape[0] : 10980, cols = Array.isArray(shape) ? shape[1] : 10980;
    // 同一 UTM 帶的格網要對齊：10 m 原點差是 10 m 的倍數、20 m（SCL）原點差是 20 m 的倍數；SCL 與 nir 的原點同 red
    const aligned = Array.isArray(tr) && tr[0] === PIXEL_M && tr[4] === -PIXEL_M
      && Array.isArray(ts) && ts[0] === 2 * PIXEL_M && ts[2] === tr[2] && ts[5] === tr[5]
      && Array.isArray(tn) && tn[2] === tr[2] && tn[5] === tr[5]
      && (tr[2] - win.ref.x) % (2 * PIXEL_M) === 0 && (win.ref.y - tr[5]) % (2 * PIXEL_M) === 0;
    if (!aligned) { skipped.push({ id: f.id, why: 'grid' }); continue; }
    const gc = (win.x0 - tr[2]) / PIXEL_M, gr = (tr[5] - win.y0) / PIXEL_M;      // 視窗 (0,0) 在這個圖幅的像元座標
    const full = { c0: Math.max(0, -gc), r0: Math.max(0, -gr), c1: Math.min(WIN, cols - gc), r1: Math.min(WIN, rows - gr) };
    if (full.c1 <= full.c0 || full.r1 <= full.r0) continue;
    cand.push({ f, gc, gr, full, dx20: (tr[2] - win.ref.x) / (2 * PIXEL_M), dy20: (win.ref.y - tr[5]) / (2 * PIXEL_M) });
  }
  const span = (a, b) => Math.floor((b - 1) / BLOCK_GUESS) - Math.floor(a / BLOCK_GUESS) + 1;
  const evaluate = order => {
    const done = [], parts = []; let cost = 0;
    for (const g of order) {
      let rects = [g.full];
      for (const d of done) rects = rects.flatMap(r => rectMinus(r, d));
      rects = rects.filter(r => r.c1 > r.c0 && r.r1 > r.r0);
      if (rects.length) { parts.push({ ...g, rects }); cost += rects.reduce((n, q) => n + span(g.gc + q.c0, g.gc + q.c1) * span(g.gr + q.r0, g.gr + q.r1), 0); }
      done.push(g.full);
    }
    return { cost, parts };
  };
  let best = evaluate(cand);
  if (cand.length > 1 && cand.length <= 5) for (const p of permutations(cand)) { const e = evaluate(p); if (e.cost < best.cost) best = e; }
  return { parts: best.parts, blocks: best.cost, skipped };
}

// ── 一景：讀 red、nir（10 m）與 SCL（20 m），拼接圖幅，算 NDVI（int16 ×10000；-32768 = 無效）────
const NDVI_NA = -32768;
async function dateNdvi(d, win, signal) {
  const plan = mosaicPlan(d.items, win);
  if (!plan.parts.length) return { ndvi: null, valid: 0, tiles: [], skipped: plan.skipped };
  const red = new Uint16Array(WIN * WIN), nir = new Uint16Array(WIN * WIN);
  // SCL 是 20 m：以參考格網（win.ref）的 20 m 像元為索引；同一帶的圖幅 20 m 格網對齊，所以各圖幅寫進同一張陣列
  const sc0 = win.col0 >> 1, sr0 = win.row0 >> 1;
  const sw = ((win.col0 + WIN - 1) >> 1) - sc0 + 1, sh = ((win.row0 + WIN - 1) >> 1) - sr0 + 1;
  const scl = new Uint8Array(sw * sh);
  const out = new Int16Array(WIN * WIN).fill(NDVI_NA);
  let valid = 0;
  const band = a => (a['raster:bands'] && a['raster:bands'][0]) || {};
  await Promise.all(plan.parts.map(async part => {
    const f = part.f;
    const [hRed, hNir, hScl] = await Promise.all([f.assets.red.href, f.assets.nir.href, f.assets.scl.href].map(u => cogHeader(u, signal)));
    if (hRed.width !== hNir.width || hRed.tileW !== hNir.tileW) throw new Error('cog: red/nir grids differ');
    const sR = band(f.assets.red).scale ?? 0.0001, oR = band(f.assets.red).offset ?? 0;
    const sN = band(f.assets.nir).scale ?? 0.0001, oN = band(f.assets.nir).offset ?? 0;
    const blocks = part.rects.length > 1 ? new Map() : null;           // L 形的兩塊可能用到同一個 COG tile
    await Promise.all(part.rects.map(async q => {
      const w = q.c1 - q.c0, h = q.r1 - q.r0;
      const s0c = ((win.col0 + q.c0) >> 1) - sc0, s1c = ((win.col0 + q.c1 - 1) >> 1) - sc0 + 1;
      const s0r = ((win.row0 + q.r0) >> 1) - sr0, s1r = ((win.row0 + q.r1 - 1) >> 1) - sr0 + 1;
      await Promise.all([
        readWindow(f.assets.red.href, hRed, part.gc + q.c0, part.gr + q.r0, w, h, red, signal, { stride: WIN, x: q.c0, y: q.r0 }, blocks),
        readWindow(f.assets.nir.href, hNir, part.gc + q.c0, part.gr + q.r0, w, h, nir, signal, { stride: WIN, x: q.c0, y: q.r0 }, blocks),
        readWindow(f.assets.scl.href, hScl, s0c + sc0 - part.dx20, s0r + sr0 - part.dy20, s1c - s0c, s1r - s0r, scl, signal, { stride: sw, x: s0c, y: s0r }, blocks),
      ]);
      for (let r = q.r0; r < q.r1; r++) {
        const srow = (((win.row0 + r) >> 1) - sr0) * sw - sc0;
        for (let c = q.c0; c < q.c1; c++) {
          const i = r * WIN + c;
          const dr = red[i], dn = nir[i];
          if (!dr || !dn) continue;                                     // 0 = no data
          if (!SCL_OK[scl[srow + ((win.col0 + c) >> 1)]]) continue;
          const rr = Math.max(0, dr * sR + oR), nn = Math.max(0, dn * sN + oN);
          const sum = rr + nn;
          if (sum < 0.01) continue;                                     // 幾乎沒有訊號（深陰影、水面眩光後的 0）
          out[i] = Math.round((nn - rr) / sum * 10000);
          valid++;
        }
      }
    }));
  }));
  return { ndvi: out, valid, tiles: plan.parts.map(p => tileName(p.f)), skipped: plan.skipped };
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
// 圓內（像元中心到基地點 ≤ R）、有值的像元為景觀；塊區 8 鄰接（FRAGSTATS 預設），
// 邊緣只算圓內兩個有值像元之間的類別交界（不算圓周、不算無資料邊）。
// 有效網目大小（effective mesh size, Jaeger 2000）＝ Σ 塊區面積² ／ 景觀面積：
// 兩個隨機落點在同一塊區的機率乘以景觀面積，越小表示越破碎。
// 四個覆蓋類型（水體 < tW、無植生 [tW,tV)、低植生 [tV,tD)、密植生 ≥ tD）各自算一組（FRAGSTATS 的 class level）。
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
    areaHa: nValid * haPerPx, ndvi: null, classes: null, patch: null,
  };
  if (!nValid) return out;
  const quantile = p => { let acc = 0; const target = p * nValid; for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc > target) return (i - 10000) / 10000; } return 1; };
  out.ndvi = { mean: sum / nValid / 10000, median: quantile(0.5), p10: quantile(0.1), p90: quantile(0.9) };
  out.classes = { water: water / nValid, bare: bare / nValid, low: low / nValid, dense: dense / nValid };
  // 塊區（8 鄰接）與邊緣（4 鄰接的類別交界，兩邊都要在圓內且有值；從類別這一側數，每條只算一次）。
  // labels 只用外接方框的那一段（索引同 inside／val），大小夠：labels.length ≥ w*h ≥ bw*bh。
  const lab = labels.subarray(0, bw * bh);
  const stack = new Int32Array(bw * bh);
  // 一個覆蓋類型的塊區指標：類型 = lo ≤ NDVI×10000 < hi 的像元
  const patchStats = (lo, hi) => {
    lab.fill(0);
    const inCls = i => inside[i] && val[i] >= lo && val[i] < hi;
    let edge = 0, total = 0, largest = 0, sumSq = 0, nPatch = 0;
    for (let r = 0; r < bh; r++) {
      for (let c = 0; c < bw; c++) {
        const i = r * bw + c;
        if (!inCls(i)) continue;
        // 右、下、左、上：鄰居在圓內、有值、但不是同一類 → 一條邊
        if (c + 1 < bw && inside[i + 1] && !inCls(i + 1)) edge++;
        if (r + 1 < bh && inside[i + bw] && !inCls(i + bw)) edge++;
        if (c > 0 && inside[i - 1] && !inCls(i - 1)) edge++;
        if (r > 0 && inside[i - bw] && !inCls(i - bw)) edge++;
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
              if (lab[q] || !inCls(q)) continue;
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
  // 每一類各自一組；不提供合併的「植生」類（低植生與密植生是不同類型的塊區，不合在一起算）
  out.patch = {
    water: patchStats(-32767, tW),
    bare: patchStats(tW, tV),
    low: patchStats(tV, tD),
    dense: patchStats(tD, 32767),
  };
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
// 每一列挑一種 PNG 濾波（None／Sub／Up／Paeth，取有號差值絕對值和最小者，與 libpng 的啟發式相同）。
// 調色盤索引依 NDVI 由低到高排（3..63），相鄰像元的差值小，Sub、Up、Paeth 通常比不濾波壓得小。
export function encodePalettePng(idx, w, h, level = 6) {
  const n = 3 + PALETTE_STEPS;
  const plte = new Uint8Array(n * 3), trns = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) { const [r, g, b] = i === 0 ? [0, 0, 0] : paletteRgb(i); plte.set([r, g, b], i * 3); }
  trns[0] = 0; trns[1] = 120;
  const raw = new Uint8Array((w + 1) * h);
  const zero = new Uint8Array(w);
  const sabs = d => (d &= 255) < 128 ? d : 256 - d;
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let r = 0; r < h; r++) {
    const cur = idx.subarray(r * w, (r + 1) * w), up = r ? idx.subarray((r - 1) * w, r * w) : zero;
    let s0 = 0, s1 = 0, s2 = 0, s4 = 0;
    for (let c = 0; c < w; c++) {
      const x = cur[c], a = c ? cur[c - 1] : 0, b = up[c], cc = c ? up[c - 1] : 0;
      s0 += sabs(x); s1 += sabs(x - a); s2 += sabs(x - b); s4 += sabs(x - paeth(a, b, cc));
    }
    const m = Math.min(s0, s1, s2, s4), ft = m === s0 ? 0 : m === s1 ? 1 : m === s2 ? 2 : 4;
    const o = r * (w + 1) + 1;
    raw[o - 1] = ft;
    if (ft === 0) raw.set(cur, o);
    else for (let c = 0; c < w; c++) {
      const x = cur[c], a = c ? cur[c - 1] : 0, b = up[c];
      raw[o + c] = (x - (ft === 1 ? a : ft === 2 ? b : paeth(a, b, c ? up[c - 1] : 0))) & 255;
    }
  }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level }))), chunk('IEND', new Uint8Array(0))];
  const len = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(len); let o = 0; for (const p of parts) { png.set(p, o); o += p.length; }
  return Buffer.from(png).toString('base64');
}
export const ndviToPaletteIndex = v => v === NDVI_NA ? 1 : v < 0 ? 2 : 3 + Math.min(PALETTE_STEPS - 1, Math.floor(Math.max(0, v / 10000) / 0.8 * (PALETTE_STEPS - 1)));

// 預覽圖：等經緯度網格，像元約 PREVIEW_PIXEL_M（預設與分析同為 10 m）。每個預覽像元反投影到 UTM 再取最近的來源像元。
// 2000×2000 像元逐點做投影太慢（Lambda 上要好幾秒），所以只在每 64 像元一點的控制格上精確計算，中間雙線性內插：
// 20 km 範圍內 UTM 與經緯度的關係很接近線性，640 m 的格內內插誤差不到 1 cm。
export function buildPreview(med, win, zone, north, px, py, pixelM = PREVIEW_PIXEL_M) {
  const corner = (c, r) => fromUtm(win.x0 + c * PIXEL_M, win.y0 - r * PIXEL_M, zone, north);
  const cs = [corner(0, 0), corner(WIN, 0), corner(0, WIN), corner(WIN, WIN)];
  const south = Math.min(...cs.map(p => p.lat)), north_ = Math.max(...cs.map(p => p.lat));
  const west = Math.min(...cs.map(p => p.lon)), east = Math.max(...cs.map(p => p.lon));
  const midLat = (south + north_) / 2;
  const wM = (east - west) * 111320 * Math.cos(rad(midLat)), hM = (north_ - south) * 110950;
  const W = Math.max(16, Math.min(PREVIEW_MAX_PX, Math.round(wM / pixelM)));
  const H = Math.max(16, Math.min(PREVIEW_MAX_PX, Math.round(W * hM / wM)));
  const STEP = 64;
  const nc = Math.ceil((W - 1) / STEP) + 1, nr = Math.ceil((H - 1) / STEP) + 1;
  const colAt = k => Math.min(W - 1, k * STEP), rowAt = k => Math.min(H - 1, k * STEP);
  const CX = new Float64Array(nr * nc), CY = new Float64Array(nr * nc);
  for (let i = 0; i < nr; i++) {
    const lat = north_ - (rowAt(i) + 0.5) / H * (north_ - south);
    for (let j = 0; j < nc; j++) {
      const q = toUtm(lat, west + (colAt(j) + 0.5) / W * (east - west), zone, north);
      CX[i * nc + j] = q.x; CY[i * nc + j] = q.y;
    }
  }
  const idx = new Uint8Array(W * H);
  const rOuter = RADII_M[RADII_M.length - 1] ** 2;
  const lx = new Float64Array(nc), ly = new Float64Array(nc);           // 這一列在各控制欄的 UTM（垂直內插）
  for (let r = 0; r < H; r++) {
    const i0 = Math.min(nr - 2, Math.floor(r / STEP)), i1 = Math.min(nr - 1, i0 + 1);
    const span = rowAt(i1) - rowAt(i0), t = span > 0 ? (r - rowAt(i0)) / span : 0;
    for (let j = 0; j < nc; j++) {
      lx[j] = CX[i0 * nc + j] + (CX[i1 * nc + j] - CX[i0 * nc + j]) * t;
      ly[j] = CY[i0 * nc + j] + (CY[i1 * nc + j] - CY[i0 * nc + j]) * t;
    }
    const rowOff = r * W;
    for (let j = 0; j < nc - 1; j++) {                                  // W ≥ 16，所以 nc ≥ 2
      const c0 = colAt(j), c1 = colAt(j + 1), cspan = Math.max(1, c1 - c0);
      const x0 = lx[j], y0 = ly[j], dx = (lx[j + 1] - x0) / cspan, dy = (ly[j + 1] - y0) / cspan;
      const cEnd = j === nc - 2 ? W : c1;                                // 最後一段含最右一欄
      for (let c = c0; c < cEnd; c++) {
        const x = x0 + dx * (c - c0), y = y0 + dy * (c - c0);
        const ex = x - px, ey = y - py;
        if (ex * ex + ey * ey > rOuter) continue;                       // 圓外透明
        const sc = Math.floor((x - win.x0) / PIXEL_M), sr = Math.floor((win.y0 - y) / PIXEL_M);
        if (sc < 0 || sr < 0 || sc >= WIN || sr >= WIN) continue;
        idx[rowOff + c] = ndviToPaletteIndex(med[sr * WIN + sc]);
      }
    }
  }
  return { png: 'data:image/png;base64,' + encodePalettePng(idx, W, H), bounds: [[south, west], [north_, east]], width: W, height: H, pixelM: +(wM / W).toFixed(2) };
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
    // 先用基地點所在的標準 UTM 帶畫出視窗外框（多放 3%，涵蓋帶與帶之間的旋轉）與圓內取樣點，只拿來查景、估涵蓋
    const zoneGuess = Math.min(60, Math.floor((lon + 180) / 6) + 1), northGuess = lat >= 0;
    const pg = toUtm(lat, lon, zoneGuess, northGuess);
    const R = RADII_M[RADII_M.length - 1];
    const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sy]) => {
      const q = fromUtm(pg.x + sx * R * 1.03, pg.y + sy * R * 1.03, zoneGuess, northGuess); return [q.lon, q.lat];
    });
    const samples = circleSamples(pg, zoneGuess, northGuess, R);
    const features = await searchScenes(ring, period, ac.signal);
    const plan = planScenes(features, samples, { maxScenes, preferZone: zoneGuess });
    if (!plan.dates.length) {
      return { error: 'no_scenes', zh: '這段期間內沒有雲量可用的 Sentinel-2 影像', period, considered: features.length };
    }
    const { epsg, zone, north } = plan;
    // 參考格網：任一張選到的圖幅的原點（同一帶的圖幅彼此對齊），視窗對齊到這個 10 m 格網
    const tr = plan.dates[0].items[0].assets.red['proj:transform'];
    if (!Array.isArray(tr) || tr[0] !== PIXEL_M || tr[4] !== -PIXEL_M) throw new Error('unexpected red transform');
    const ref = { x: tr[2], y: tr[5] };
    const p = toUtm(lat, lon, zone, north);
    const colP = (p.x - ref.x) / PIXEL_M, rowP = (ref.y - p.y) / PIXEL_M;
    const win = { ref, col0: Math.round(colP) - HALF_PX, row0: Math.round(rowP) - HALF_PX };
    win.x0 = ref.x + win.col0 * PIXEL_M; win.y0 = ref.y - win.row0 * PIXEL_M;
    const cx = colP - win.col0, cy = rowP - win.row0;                 // 基地點在視窗內的像元座標（浮點）

    const layers = [], used = [], skipped = [];
    let i = 0;
    const worker = async () => {
      while (i < plan.dates.length) {
        const d = plan.dates[i++];
        const id = d.items.map(f => f.id).join('+');
        if (Date.now() > t0 + fetchDeadlineMs) { skipped.push({ id, date: d.date, why: 'time' }); continue; }
        try {
          const r = await dateNdvi(d, win, ac.signal);
          r.skipped.forEach(x => skipped.push({ ...x, date: d.date }));
          if (r.valid > 0) {
            layers.push(r.ndvi);
            used.push({ id, date: d.date, cloud: Math.round(d.cloud * 10) / 10, coverage: Math.round(d.coverage * 1000) / 1000, tiles: r.tiles, validShare: r.valid / (WIN * WIN) });
          } else skipped.push({ id, date: d.date, why: 'all_masked' });
        } catch (e) {
          const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e)));
          skipped.push({ id, date: d.date, why: aborted ? 'time' : String(e && e.message || e).slice(0, 80) });
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
    const tPreview = Date.now();
    const preview = buildPreview(med, win, zone, north, p.x, p.y);
    const elapsed = Date.now() - t0;
    const tiles = [...new Set(used.flatMap(u => u.tiles))].sort();
    return {
      source: { collection: COLLECTION, grid: tiles.join('+'), grids: tiles.map(t => 'MGRS-' + t), epsg, zone, pixelM: PIXEL_M, stac: STAC,
        scenesConsidered: plan.considered, scenesInZone: plan.inZone, datesInZone: plan.datesInZone,
        windowCoverage: Math.round(plan.coverage * 1000) / 1000, tilesNeeded: plan.tilesNeeded },
      period, scenes: used, skipped,
      thresholds: THRESHOLDS,
      observations: { noData: nIn ? hist[0] / nIn : 0, ge3Share: nIn ? ge3 / nIn : 0, histogram: Array.from(hist) },
      radii, preview,
      notes: buildNotes(used.length, period, tiles),
      timing: { fetchMs: tFetch, previewMs: elapsed - (tPreview - t0), totalMs: elapsed, overBudget: elapsed > deadline - t0 },
    };
  } finally {
    clearTimeout(killer);
  }
}

// 這段話會原樣顯示在介面與報告附錄；資料的性質要跟著資料一起走
function buildNotes(nScenes, period, tiles = []) {
  return [
    `NDVI 為 ${period.start}～${period.end} 期間 ${nScenes} 景 Sentinel-2 Level-2A 影像、經 SCL 雲遮罩後的逐像元中位數合成，像元 10 m。`,
    ...(tiles.length > 1 ? [`20 km 視窗跨 ${tiles.length} 個 Sentinel-2 圖幅（${tiles.join('、')}）：同一天、同一軌道的相鄰圖幅拼接成一景（同一 UTM 帶，像元格網對齊，未重新取樣）。`] : []),
    '植生（NDVI ≥ 0.2）與密植生（NDVI ≥ 0.5）是通用門檻，不是在地校正的土地覆蓋分類；農田、人工草坪也會被算成植生，密植生不等於天然林。',
    'NDVI 量的是綠色生物量與活力，不是棲地品質；塊區（patch）是同一覆蓋類型（水體、無植生、低植生、密植生）依門檻切出來的連續像元（8 鄰接），四類分別計算、不合併，不是依土地利用或植群調查劃分。',
    '水體以 NDVI < 0 判定，會把陰影、裸露濕地一併算進去；山區陡坡的陰影也可能壓低 NDVI。',
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
  const key = `${lat.toFixed(4)}|${lon.toFixed(4)}|${months}|${periodFor(months).start}|${q.v || ''}`;
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
    'netlify-vary': 'query=lat|lon|months|v',
  };
}

export const config = { path: '/api/ndvi' };

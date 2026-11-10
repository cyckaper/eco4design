// /api/ndvi 的功能測試
//   node test/ndvi.test.mjs
// 不需要網路：fetch 換成假的——STAC 回一組假的景，影像是在記憶體裡現做的 Cloud-Optimized GeoTIFF
// （tile、deflate、predictor 2，和 Earth Search 上的 Sentinel-2 COG 同一種寫法），Range 請求照切。
// 守的是：
//   - WGS84 ↔ UTM 與 pyproj 的結果差在公分以內（基地點落錯一個像元，所有半徑的數字都會錯）
//   - COG 讀取：IFD、tile 表、predictor 還原、視窗跨 tile、視窗超出影像的部分留 no data
//   - 雲遮罩：SCL 標為雲的像元不進中位數，即使它的 NDVI 看起來正常
//   - 景觀指標：已知圖形（一塊 20×20 像元的密植生、一塊 10×10 的水）算出來的覆蓋、塊區、邊緣、有效網目與手算一致
//   - 預覽圖是合法的 PNG；回應含來源、期間、景與說明
//   - 抓取逾時只是少幾景，不是整個失敗
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'netlify', 'functions', 'ndvi.mjs');
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  readFileSync(SRC, 'utf8').replace(/from 'node:/g, "from 'node:")).toString('base64'));
const { toUtm, fromUtm, periodFor, parseIfd0, cogHeader, readWindow, pickScenes, medianComposite, landscapeMetrics, analyze, RADII_M, THRESHOLDS } = mod;
const handler = mod.default;

const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 1. 投影：與 pyproj 3.8（EPSG:326xx／327xx）比對 ──────────────────────────
const REF = [[25.034, 121.5645, 51, 355174.205, 2769480.345], [23.673, 120.795, 51, 275126.161, 2619761.831],
  [22.0, 120.74, 51, 266677.069, 2434551.381], [23.5, 119.58, 50, 763479.607, 2601237.911],
  [56.19, -3.97, 30, 439801.448, 6227649.813], [-39.4, 176.9, 60, 491389.79, 5638828.69],
  [34.12, -117.2, 11, 481556.432, 3775479.526], [-27.5, 153.0, 56, 500000.0, 6958183.184]];
let projErr = 0, invErr = 0;
for (const [lat, lon, zone, x, y] of REF) {
  const p = toUtm(lat, lon, zone, lat >= 0);
  projErr = Math.max(projErr, Math.abs(p.x - x), Math.abs(p.y - y));
  const q = fromUtm(x, y, zone, lat >= 0);
  invErr = Math.max(invErr, Math.abs(q.lat - lat) * 111000, Math.abs(q.lon - lon) * 111000 * Math.cos(lat * Math.PI / 180));
}
check('toUtm 與 pyproj 差 < 1 cm（臺灣、英國、紐西蘭、加州、昆士蘭）', projErr < 0.01, projErr + ' m');
check('fromUtm 反算差 < 1 cm', invErr < 0.01, invErr + ' m');

// ── 2. 期間：本月 1 日往前 N 個月 ──────────────────────────────────────────
const per = periodFor(12, new Date('2026-11-09T05:00:00Z'));
check('periodFor(12)：2025-11-01 ～ 2026-11-01', per.start === '2025-11-01' && per.end === '2026-11-01', JSON.stringify(per));
const per24 = periodFor(24, new Date('2026-01-31T23:00:00Z'));
check('periodFor(24) 跨年：2024-01-01 ～ 2026-01-01', per24.start === '2024-01-01' && per24.end === '2026-01-01', JSON.stringify(per24));

// ── 假的 COG 產生器 ──────────────────────────────────────────────────────────
// fill(row, col) 回像元值；只寫出 tileFilter 選到的 tile（其他留 count 0，與 COG 的空 tile 一樣）
function makeCog({ width, height, tileW, tileH, bytes, fill, tileFilter = () => true, predictor = 2 }) {
  const across = Math.ceil(width / tileW), down = Math.ceil(height / tileH);
  const n = across * down;
  const tiles = [];
  for (let t = 0; t < n; t++) {
    const tr = Math.floor(t / across), tc = t % across;
    if (!tileFilter(tr, tc)) { tiles.push(null); continue; }
    const arr = bytes === 2 ? new Uint16Array(tileW * tileH) : new Uint8Array(tileW * tileH);
    for (let r = 0; r < tileH; r++) for (let c = 0; c < tileW; c++) {
      const R = tr * tileH + r, C = tc * tileW + c;
      arr[r * tileW + c] = R < height && C < width ? fill(R, C) : 0;
    }
    if (predictor === 2) {
      const mask = bytes === 2 ? 0xffff : 0xff;
      for (let r = 0; r < tileH; r++) for (let c = tileW - 1; c > 0; c--) arr[r * tileW + c] = (arr[r * tileW + c] - arr[r * tileW + c - 1]) & mask;
    }
    tiles.push(deflateSync(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)));
  }
  // IFD：13 個欄位；tile 表放在 IFD 之後
  const entries = [[256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, bytes * 8], [259, 3, 1, 8], [262, 3, 1, 1], [277, 3, 1, 1],
    [317, 3, 1, predictor], [322, 4, 1, tileW], [323, 4, 1, tileH], [324, 4, n, null], [325, 4, n, null], [339, 3, 1, 1]];
  const ifdOff = 8, ifdLen = 2 + entries.length * 12 + 4;
  const offTab = ifdOff + ifdLen, cntTab = offTab + n * 4, dataStart = cntTab + n * 4;
  let pos = dataStart;
  const offsets = [], counts = [];
  for (const t of tiles) { if (!t) { offsets.push(0); counts.push(0); continue; } offsets.push(pos); counts.push(t.length); pos += t.length; }
  const buf = Buffer.alloc(pos);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOff, 4);
  buf.writeUInt16LE(entries.length, ifdOff);
  entries.forEach(([tag, type, cnt, val], i) => {
    const p = ifdOff + 2 + i * 12;
    buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(cnt, p + 4);
    if (tag === 324) buf.writeUInt32LE(offTab, p + 8);
    else if (tag === 325) buf.writeUInt32LE(cntTab, p + 8);
    else if (type === 3) buf.writeUInt16LE(val, p + 8);
    else buf.writeUInt32LE(val, p + 8);
  });
  buf.writeUInt32LE(0, ifdOff + 2 + entries.length * 12);
  offsets.forEach((o, i) => buf.writeUInt32LE(o, offTab + i * 4));
  counts.forEach((c, i) => buf.writeUInt32LE(c, cntTab + i * 4));
  tiles.forEach((t, i) => { if (t) t.copy(buf, offsets[i]); });
  return buf;
}

// 假的 fetch：mem:// 檔案照 Range 切；STAC 回 features
const FILES = new Map();
let STAC_FEATURES = [];
let requests = [];
let slowHosts = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push(u);
  if (u.includes('earth-search')) {
    return new Response(JSON.stringify({ type: 'FeatureCollection', features: STAC_FEATURES }), { status: 200, headers: { 'content-type': 'application/geo+json' } });
  }
  if (u.startsWith('mem://')) {
    const host = u.slice(6).split('/')[0];
    if (slowHosts.has(host)) {
      await new Promise((res, rej) => { const t = setTimeout(res, 60000); opts.signal && opts.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    }
    const f = FILES.get(u);
    if (!f) return new Response('not found', { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec(opts.headers && (opts.headers.range || opts.headers.Range) || '');
    if (!m) return new Response(f, { status: 200 });
    const a = +m[1], b = Math.min(+m[2], f.length - 1);
    return new Response(f.subarray(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${f.length}` } });
  }
  throw new Error('unexpected fetch ' + u);
};

// ── 3. COG 讀取 ────────────────────────────────────────────────────────────
{
  const W = 2300, H = 2300, TW = 1024;                               // 3×3 tile，最後一排不滿
  const buf = makeCog({ width: W, height: H, tileW: TW, tileH: TW, bytes: 2, fill: (r, c) => (r * 7 + c * 3) & 0xffff });
  FILES.set('mem://t/a.tif', buf);
  const hdr = await cogHeader('mem://t/a.tif');
  check('IFD0：尺寸、tile、deflate、predictor 2、uint16', hdr.width === W && hdr.tileW === TW && hdr.comp === 8 && hdr.pred === 2 && hdr.bps === 16 && hdr.offsets.length === 9, JSON.stringify({ ...hdr, offsets: hdr.offsets.length }));
  // 視窗跨 4 個 tile，右下超出影像
  const col0 = 1000, row0 = 1900, w = 1400, h = 600;
  const out = new Uint16Array(w * h);
  const nTiles = await readWindow('mem://t/a.tif', hdr, col0, row0, w, h, out);
  let bad = 0, outside = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const R = row0 + r, C = col0 + c, v = out[r * w + c];
    if (R >= H || C >= W) { if (v !== 0) outside++; continue; }
    if (v !== ((R * 7 + C * 3) & 0xffff)) bad++;
  }
  check('readWindow：跨 6 個 tile 的視窗每個像元都對，超出影像處為 0', bad === 0 && outside === 0 && nTiles === 6, `bad=${bad} outside=${outside} tiles=${nTiles}`);
  // 負的起點（視窗在影像左上之外）
  const out2 = new Uint16Array(50 * 50);
  await readWindow('mem://t/a.tif', hdr, -20, -20, 50, 50, out2);
  let bad2 = 0;
  for (let r = 0; r < 50; r++) for (let c = 0; c < 50; c++) {
    const R = r - 20, C = c - 20, v = out2[r * 50 + c];
    const want = R < 0 || C < 0 ? 0 : (R * 7 + C * 3) & 0xffff;
    if (v !== want) bad2++;
  }
  check('readWindow：視窗起點為負時，影像外為 0、影像內正確', bad2 === 0, 'bad=' + bad2);
  // 大端或非 tile 的檔要明確報錯
  const be = Buffer.from(buf); be.write('MM', 0, 'ascii');
  let threw = '';
  try { parseIfd0(be); } catch (e) { threw = e.message; }
  check('big-endian TIFF 報錯而不是亂讀', /big-endian/.test(threw), threw);
}

// ── 4. 端到端：四景 + 一景全雲 + 一景抓不到 ────────────────────────────────
// 假的 MGRS 格：transform 與 51RUH 相同（x0 300000、y0 2800020，10980 像元）
const X0 = 300000, Y0 = 2800020, N10 = 10980, ZONE = 51;
// 基地點：落在影像像元 (1100.4, 1100.4)，視窗起點是 (100, 100)——離格邊 1 km，四角都在資料範圍內
const C0 = 1100.4;
const PX = X0 + C0 * 10, PY = Y0 - C0 * 10;
const site = fromUtm(PX, PY, ZONE, true);
const corner = (x, y) => { const p = fromUtm(x, y, ZONE, true); return [p.lon, p.lat]; };
const TILE_GEOM = { type: 'Polygon', coordinates: [[corner(X0, Y0), corner(X0 + N10 * 10, Y0), corner(X0 + N10 * 10, Y0 - N10 * 10), corner(X0, Y0 - N10 * 10), corner(X0, Y0)]] };
// 另一格：幾何只蓋到視窗的一角，景也比較少——不該被選到
const FAR_GEOM = { type: 'Polygon', coordinates: [[corner(X0 - 50000, Y0 + 50000), corner(X0 + 5000, Y0 + 50000), corner(X0 + 5000, Y0 - 5000), corner(X0 - 50000, Y0 - 5000), corner(X0 - 50000, Y0 + 50000)]] };

// 反射率 → DN（scale 0.0001、offset -0.1）
const dn = refl => Math.round((refl + 0.1) / 0.0001);
// 圖形（影像像元座標）
const inDense = (r, c) => r >= 1110 && r < 1130 && c >= 1110 && c < 1130;   // 20×20 密植生（NDVI 0.8），中心東南 100–300 m
const inWater = (r, c) => r >= 1050 && r < 1060 && c >= 1050 && c < 1060;   // 10×10 水（NDVI -0.3），中心西北約 700 m
const redOf = (r, c) => inDense(r, c) ? dn(0.03) : dn(0.05);
const nirOf = (r, c) => inDense(r, c) ? dn(0.27) : inWater(r, c) ? dn(0.0269) : dn(0.0929);  // 背景 NDVI 0.3
// 只寫會被讀到的 tile（視窗 100..2099 → 1024 tile 0、1、2；SCL 視窗 50..1050 → 512 tile 0、1、2）
const win2 = (tr, tc) => tr < 3 && tc < 3;
const sclWin = (tr, tc) => tr < 3 && tc < 3;

function makeScene(id, date, cloud, { cloudBand = false, nodataBlock = false, gridCode = 'MGRS-51RUH', geom = TILE_GEOM } = {}) {
  const base = `mem://${id}/`;
  // cloudBand：第 1000–1004 列整列是雲（SCL 9），而且反射率看起來正常（NDVI 0）——必須被遮掉
  const isCloud = (r, c) => cloudBand && r >= 1100 && r < 1105;
  const isNodata = (r, c) => nodataBlock && r < 400 && c < 400;
  FILES.set(base + 'B04.tif', makeCog({ width: N10, height: N10, tileW: 1024, tileH: 1024, bytes: 2, tileFilter: win2,
    fill: (r, c) => isNodata(r, c) ? 0 : isCloud(r, c) ? dn(0.4) : redOf(r, c) }));
  FILES.set(base + 'B08.tif', makeCog({ width: N10, height: N10, tileW: 1024, tileH: 1024, bytes: 2, tileFilter: win2,
    fill: (r, c) => isNodata(r, c) ? 0 : isCloud(r, c) ? dn(0.4) : nirOf(r, c) }));
  FILES.set(base + 'SCL.tif', makeCog({ width: N10 / 2, height: N10 / 2, tileW: 512, tileH: 512, bytes: 1, tileFilter: sclWin,
    fill: (r, c) => isNodata(r * 2, c * 2) ? 0 : isCloud(r * 2, c * 2) || isCloud(r * 2 + 1, c * 2) ? 9 : inWater(r * 2, c * 2) ? 6 : 4 }));
  const band = [{ nodata: 0, data_type: 'uint16', spatial_resolution: 10, scale: 0.0001, offset: -0.1 }];
  const asset = (name, res) => ({ href: base + name, 'proj:shape': [N10 * 10 / res, N10 * 10 / res], 'proj:transform': [res, 0, X0, 0, -res, Y0], 'raster:bands': res === 10 ? band : [{ data_type: 'uint8', spatial_resolution: 20 }] });
  return { id, bbox: [0, 0, 0, 0], geometry: geom,
    properties: { datetime: date + 'T02:40:00Z', 'eo:cloud_cover': cloud, 'grid:code': gridCode, 'proj:epsg': 32651, 's2:processing_baseline': '05.11', 's2:nodata_pixel_percentage': 0 },
    assets: { red: asset('B04.tif', 10), nir: asset('B08.tif', 10), scl: asset('SCL.tif', 20) } };
}

STAC_FEATURES = [
  makeScene('S1', '2026-01-15', 5),
  makeScene('S2', '2026-04-15', 12, { cloudBand: true }),
  makeScene('S3', '2026-07-15', 30, { nodataBlock: true }),
  makeScene('S4', '2026-10-15', 8),
  makeScene('S5', '2026-02-10', 40),
  makeScene('FAR1', '2026-03-01', 1, { gridCode: 'MGRS-51RUG', geom: FAR_GEOM }),
  makeScene('FAR2', '2026-06-01', 2, { gridCode: 'MGRS-51RUG', geom: FAR_GEOM }),
];

// pickScenes：選對格、分季
{
  const corners = [[-10000, -10000], [10000, -10000], [-10000, 10000], [10000, 10000]].map(([dx, dy]) => corner(PX + dx, PY + dy));
  const picked = pickScenes(STAC_FEATURES, corners, 8);
  check('pickScenes 選四角都在資料範圍內的 MGRS 格，不選雲量最低但只蓋一角的那格', picked.grid === 'MGRS-51RUH' && picked.cover === 4, JSON.stringify({ grid: picked.grid, cover: picked.cover }));
  check('pickScenes 分季取景、依日期排序', picked.scenes.map(f => f.id).join(',') === 'S1,S5,S2,S3,S4', picked.scenes.map(f => f.id).join(','));
  const few = pickScenes(STAC_FEATURES.filter(f => /^S/.test(f.id)), corners, 2);
  check('pickScenes 上限 2 景：兩個不同季別中雲量最低的（S1、S4）', few.scenes.map(f => f.id).join(',') === 'S1,S4', few.scenes.map(f => f.id).join(','));
}

// 手算期望值（獨立於 landscapeMetrics 的實作）
const cx = C0, cy = C0;
function expectFor(Rm) {
  const R = Rm / 10; let nIn = 0, dense = 0, water = 0;
  for (let r = Math.floor(cy - R) - 2; r <= Math.ceil(cy + R) + 2; r++) for (let c = Math.floor(cx - R) - 2; c <= Math.ceil(cx + R) + 2; c++) {
    const dy = r + 0.5 - cy, dx = c + 0.5 - cx;
    if (dx * dx + dy * dy > R * R) continue;
    nIn++; if (inDense(r, c)) dense++; if (inWater(r, c)) water++;
  }
  return { nIn, dense, water };
}

const t0 = Date.now();
requests = [];
const res = await analyze(site.lat, site.lon, 12, { now: new Date('2026-11-09T05:00:00Z') });
const ms = Date.now() - t0;
check('analyze 完成且不報錯', !res.error, JSON.stringify(res).slice(0, 300));
// NDVI_FIXTURE=1：把這份合成結果存成 test/fixtures/ndvi_sample.json（test/ndvi-ui.mjs 用的假回應）
if (process.env.NDVI_FIXTURE) (await import('node:fs')).writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ndvi_sample.json'), JSON.stringify({ ...res, cache: 'miss', ms: 1234 }));
if (!res.error) {
  check('用了 5 景（本格全部），跳過 0 景', res.scenes.length === 5 && res.skipped.length === 0, JSON.stringify({ scenes: res.scenes.map(s => s.id), skipped: res.skipped }));
  check('回應含來源、期間、門檻、說明與預覽', res.source.grid === 'MGRS-51RUH' && res.period.start === '2025-11-01' && res.thresholds.veg === 0.2 && res.notes.length >= 4 && res.preview && res.preview.png.startsWith('data:image/png;base64,'), Object.keys(res).join(','));
  const png = Buffer.from(res.preview.png.split(',')[1], 'base64');
  const sig = png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const pw = png.readUInt32BE(16), ph = png.readUInt32BE(20);
  check('預覽圖是 PNG，寬 384、高接近 384（方形視窗）、8 位元調色盤', sig && pw === 384 && Math.abs(ph - 384) <= 8 && png[24] === 8 && png[25] === 3, `${sig} ${pw}×${ph} depth ${png[24]} type ${png[25]} bytes ${png.length}`);
  const b = res.preview.bounds;
  check('預覽邊界含基地點，約 20 km 見方', b[0][0] < site.lat && site.lat < b[1][0] && b[0][1] < site.lon && site.lon < b[1][1] && near((b[1][0] - b[0][0]) * 111000, 20000, 400), JSON.stringify(b));
  const r500 = res.radii.find(x => x.r === 500), r1k = res.radii.find(x => x.r === 1000), r5k = res.radii.find(x => x.r === 5000), r10k = res.radii.find(x => x.r === 10000);
  check('四個半徑都在', res.radii.map(x => x.r).join(',') === '500,1000,5000,10000', res.radii.map(x => x.r).join(','));
  const e500 = expectFor(500), e1k = expectFor(1000);
  check('500 m：圓內像元數與手算一致，全部有值（雲與無資料被其他景補上）', r500.pixels === e500.nIn && r500.valid === e500.nIn, JSON.stringify({ pixels: r500.pixels, valid: r500.valid, want: e500.nIn }));
  check('500 m：密植生 400 像元（4 ha）、沒有水、沒有裸露', near(r500.classes.dense, 400 / e500.nIn, 1e-9) && r500.classes.water === 0 && r500.classes.bare === 0, JSON.stringify(r500.classes));
  check('500 m：密植生 1 個塊區、4 ha、最大塊區比例 400/n、邊緣 800 m、有效網目 = 4²/景觀面積', r500.patch.dense.patches === 1 && near(r500.patch.dense.largestHa, 4, 1e-9) && near(r500.patch.dense.largestShare, 400 / e500.nIn, 1e-9)
    && near(r500.patch.dense.edgeMPerHa, 800 / (e500.nIn * 0.01), 1e-6) && near(r500.patch.dense.meshHa, 16 / (e500.nIn * 0.01), 1e-6), JSON.stringify(r500.patch.dense));
  check('500 m：低植生塊區 1 個（背景，密植生是洞）、佔 1−400/n、邊緣 = 與密植生的交界 800 m；水體與無植生 0 個塊區', r500.patch.low.patches === 1 && near(r500.patch.low.share, 1 - 400 / e500.nIn, 1e-9)
    && near(r500.patch.low.edgeMPerHa, 800 / (e500.nIn * 0.01), 1e-6) && r500.patch.water.patches === 0 && r500.patch.bare.patches === 0 && r500.patch.water.edgeMPerHa === 0, JSON.stringify({ low: r500.patch.low, water: r500.patch.water }));
  check('四類分別計算、不合併：各類塊區面積比例相加 = 1，且沒有合併的「植生」類', near(r500.patch.water.share + r500.patch.bare.share + r500.patch.low.share + r500.patch.dense.share, 1, 1e-9) && r500.veg === undefined && r500.dense === undefined, JSON.stringify(Object.keys(r500)));
  check('500 m：NDVI 中位數 0.3、p90 0.3、平均略高', near(r500.ndvi.median, 0.3, 0.0005) && near(r500.ndvi.p90, 0.3, 0.0005) && r500.ndvi.mean > 0.3 && r500.ndvi.mean < 0.35, JSON.stringify(r500.ndvi));
  check('1 km：水 100 像元、密植生 400 像元', near(r1k.classes.water, 100 / e1k.nIn, 1e-9) && near(r1k.classes.dense, 400 / e1k.nIn, 1e-9) && r1k.pixels === e1k.nIn, JSON.stringify({ ...r1k.classes, pixels: r1k.pixels, want: e1k.nIn }));
  check('1 km：水體 1 個塊區、1 ha、邊緣 = 水的周長 400 m；低植生 1 個塊區，邊緣 = 水 400 m + 密植生 800 m', r1k.patch.water.patches === 1 && near(r1k.patch.water.largestHa, 1, 1e-9) && near(r1k.patch.water.edgeMPerHa, 400 / (e1k.nIn * 0.01), 1e-6)
    && r1k.patch.low.patches === 1 && near(r1k.patch.low.edgeMPerHa, 1200 / (e1k.nIn * 0.01), 1e-6), JSON.stringify({ water: r1k.patch.water, low: r1k.patch.low }));
  check('5 km 與 10 km：圓貼齊視窗邊，全部有值，密植生仍是 1 個塊區', r5k.validShare === 1 && r10k.validShare > 0.999 && r5k.patch.dense.patches === 1 && r10k.patch.dense.patches === 1, JSON.stringify({ v5: r5k.validShare, v10: r10k.validShare, d5: r5k.patch.dense.patches, d10: r10k.patch.dense.patches }));
  check('觀測次數：雲帶與無資料區只少一次觀測，沒有像元是 0 次', res.observations.noData === 0 && res.observations.ge3Share === 1 && res.observations.histogram[5] > 0 && res.observations.histogram[4] > 0, JSON.stringify(res.observations));
  const nRange = requests.filter(u => u.startsWith('mem://')).length;
  check('每景 3 個檔頭 + 9+9 個影像 tile + 9 個 SCL tile 的 Range 請求（5 景 = 150 次）', nRange === 150, nRange);
  check(`整個流程在 8 秒內（${ms} ms）`, ms < 8000, ms + ' ms');
}

// ── 5. 中位數：偶數個取中間兩者平均、全無效為 NA ───────────────────────────
{
  const NA = -32768;
  const { med, cnt } = medianComposite([Int16Array.from([1000, NA, 5000]), Int16Array.from([3000, NA, 1000]), Int16Array.from([2000, NA, NA]), Int16Array.from([9000, NA, 2000])], 3);
  check('medianComposite：4 值取中間平均 2500、全 NA 為 NA、3 值取中位 2000', med[0] === 2500 && med[1] === NA && cnt[1] === 0 && med[2] === 2000 && cnt[2] === 3, Array.from(med) + ' / ' + Array.from(cnt));
}

// ── 6. 抓取逾時：一景永遠不回 → 只少那一景 ────────────────────────────────
{
  slowHosts = new Set(['S3']);
  const t1 = Date.now();
  const r = await analyze(site.lat, site.lon, 12, { now: new Date('2026-11-09T05:00:00Z'), budgetMs: 9000, fetchDeadlineMs: 2000 });
  const dt = Date.now() - t1;
  slowHosts = new Set();
  check('一景卡住：其餘 4 景照常完成，卡住的那景標 time', !r.error && r.scenes.length === 4 && r.skipped.some(s => s.id === 'S3' && s.why === 'time'), JSON.stringify({ err: r.error, scenes: r.scenes && r.scenes.map(s => s.id), skipped: r.skipped }));
  check(`卡住時在抓取截止 + 4 秒內結束（${dt} ms）`, dt < 7500, dt + ' ms');
}

// ── 7. HTTP 層：參數檢查、來源、快取鍵 ─────────────────────────────────────
{
  const req = (qs, headers = {}) => new Request('https://eco4design.healsdesign.org/api/ndvi' + qs, { headers });
  const bad = await handler(req('?lat=91&lon=121'), {});
  check('lat 超出範圍 → 400', bad.status === 400, bad.status);
  const forbidden = await handler(req(`?lat=${site.lat}&lon=${site.lon}`, { origin: 'https://evil.example' }), {});
  check('不在白名單的 Origin → 403', forbidden.status === 403, forbidden.status);
  const post = await handler(new Request('https://eco4design.healsdesign.org/api/ndvi', { method: 'POST' }), {});
  check('POST → 405（只收 GET，CDN 才能快取）', post.status === 405, post.status);
  const ok = await handler(req(`?lat=${site.lat}&lon=${site.lon}&months=12`), { ip: '1.2.3.4' });
  const body = await ok.json();
  check('正常請求 200、CDN 快取標頭、x-ndvi-cache miss', ok.status === 200 && body.scenes.length === 5 && ok.headers.get('netlify-cdn-cache-control') === 'public, max-age=86400, durable' && ok.headers.get('x-ndvi-cache') === 'miss', `${ok.status} ${ok.headers.get('netlify-cdn-cache-control')} ${ok.headers.get('x-ndvi-cache')}`);
  const again = await handler(req(`?lat=${(site.lat + 0.00001).toFixed(6)}&lon=${site.lon}&months=12`), { ip: '1.2.3.4' });
  check('同一基地（四位小數相同）第二次命中記憶體快取', again.headers.get('x-ndvi-cache') === 'hit', again.headers.get('x-ndvi-cache'));
}

globalThis.fetch = realFetch;
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

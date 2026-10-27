// /api/osm 共用代查的功能測試
//   node test/osm.test.mjs
// 不需要網路：以 stub 取代 fetch，實際執行 edge function 的 handler。
// 整份約 80 秒——其中幾項刻意等到逾時觸發，那正是要驗的行為。
//
// 這個端點同時服務棲共生、基地分析工作站、分區與動線、小布路書，
// 改動它會同時影響四個站台，所以每一條都是真的踩過的坑：
//   - 逾時沒有總預算 → 被 Netlify 中止，回 500 且白等 36 秒
//   - OVERPASS_ENDPOINT 的 <金鑰> 角括號沒刪 → 無聲忽略，查不出原因
//   - x-osm-keyed 加在變數宣告之前 → 每次快取命中都拋 ReferenceError
//   - 只靠 CORS 標頭限制來源 → 請求照樣打到上游，額度照樣被吃
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'netlify', 'edge-functions', 'osm.js');
const mod = await import('data:text/javascript;base64,' +
  Buffer.from(readFileSync(SRC, 'utf8')).toString('base64'));
const handler = mod.default;

const QUERY = '[out:json][timeout:25];(node["natural"="peak"](24.77,121.53,24.80,121.57););out tags center;';
let n = 0;
const makeReq = () => new Request('https://eco4design.healsdesign.org/api/osm', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  // 每個測試用不同 bbox，否則會打到模組內建的快取而測不到上游邏輯
  body: 'data=' + encodeURIComponent(QUERY.replace('24.77', `24.7${++n}`)),
});

const realFetch = globalThis.fetch;
let results = [], failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

// ── 1. 上游卡住（這就是線上回 500 的情境）──────────────────────────────
globalThis.fetch = (_url, opts) => new Promise((_res, rej) => {
  opts.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  });
});
let t0 = Date.now();
let res = await handler(makeReq(), { ip: '1.1.1.1' });
let ms = Date.now() - t0;
let body = await res.json();

check('上游卡住時回 503（不是被平台中止的 500）', res.status === 503, res.status);
// 線上觀察到平台實際在約 36 秒就中止（不是文件寫的 40 秒），所以門檻壓在 30 秒
check('在平台中止之前回應（實測 ' + ms + ' ms，須 < 30000）', ms < 30000, ms + ' ms');
check('回報耗時供診斷', typeof body.ms === 'number', JSON.stringify(body.ms));
check('預算用完後不再試下一台（有 skipped 紀錄）',
  body.attempts.some(a => /time budget/.test(a.detail || '')),
  JSON.stringify(body.attempts));
check('診斷只含主機名，不含金鑰路徑',
  body.attempts.every(a => !/interpreter|\/v1\//.test(a.endpoint)),
  JSON.stringify(body.attempts.map(a => a.endpoint)));

// ── 2. 上游秒回失敗 → 預算幾乎沒消耗，應該多試幾台 ──────────────────────
let calls = 0;
globalThis.fetch = async () => { calls++; return new Response('busy', { status: 429 }); };
t0 = Date.now();
res = await handler(makeReq(), { ip: '2.2.2.2' });
ms = Date.now() - t0;
body = await res.json();
check('快速失敗時三台公用伺服器全部試過', calls === 3, calls + ' 次呼叫');
check('快速失敗時幾乎不花時間（實測 ' + ms + ' ms）', ms < 3000, ms + ' ms');
check('全部失敗仍回 503', res.status === 503, res.status);

// ── 3. 正常成功路徑沒被改壞 ───────────────────────────────────────────
globalThis.fetch = async () => new Response(JSON.stringify({ elements: [{ type: 'node', id: 1 }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });
res = await handler(makeReq(), { ip: '3.3.3.3' });
body = await res.json();
check('成功時回 200', res.status === 200, res.status);
check('標示實際使用的上游主機', !!res.headers.get('x-osm-source'), res.headers.get('x-osm-source'));
check('回傳上游資料', Array.isArray(body.elements) && body.elements.length === 1, JSON.stringify(body));

// ── 4. 第一台「快速」失敗、第二台正常 → 應成功切換 ─────────────────────
// 這是壅塞時的常見樣貌（上游秒回 429／503），預算幾乎沒消耗，換台要能成功。
let i = 0;
globalThis.fetch = async () => {
  if (i++ === 0) return new Response('busy', { status: 429 });
  return new Response(JSON.stringify({ elements: [{ type: 'way', id: 7 }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
t0 = Date.now();
res = await handler(makeReq(), { ip: '4.4.4.4' });
ms = Date.now() - t0;
check('第一台快速失敗時切到第二台成功（實測 ' + ms + ' ms）', res.status === 200, res.status);
check('切換幾乎不花時間', ms < 3000, ms + ' ms');

// ── 5. 第一台「卡住」→ 只做一次完整嘗試，不把等待疊加上去 ────────────────
// 刻意的取捨：上游卡住時，代查做一次認真的嘗試（夠長，足以等到實測 25 秒才回的慢速伺服器），
// 其餘廣度交給前端自己的備援鏈，否則兩邊的等待會疊成近一分鐘。
globalThis.fetch = (_url, opts) => new Promise((_r, rej) =>
  opts.signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  }));
t0 = Date.now();
res = await handler(makeReq(), { ip: '5.5.5.5' });
ms = Date.now() - t0;
body = await res.json();
const realTries = body.attempts.filter(a => !/time budget/.test(a.detail || '')).length;
check('上游卡住時只做一次完整嘗試（實際嘗試 ' + realTries + ' 台）', realTries === 1, realTries);
check('單台上限容得下實測 25.1 秒才回的慢速伺服器', ms >= 25000, ms + ' ms');
check('仍在平台上限內回應（實測 ' + ms + ' ms，須 < 30000）', ms < 30000, ms + ' ms');

// ── 6. 快取命中路徑（曾因 keyed 在宣告前被引用而每次命中都拋 ReferenceError）──
globalThis.fetch = async () => new Response(JSON.stringify({ elements: [{ type: 'node', id: 9 }] }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const sameBody = 'data=' + encodeURIComponent(QUERY.replace('24.77', '24.99'));
const twice = () => new Request('https://eco4design.healsdesign.org/api/osm',
  { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: sameBody });
const first = await handler(twice(), { ip: '6.6.6.6' });
const second = await handler(twice(), { ip: '6.6.6.6' });
check('第一次為 miss', first.headers.get('x-osm-cache') === 'miss', first.headers.get('x-osm-cache'));
check('第二次命中快取且不拋錯', second.status === 200 && second.headers.get('x-osm-cache') === 'hit',
  second.status + ' / ' + second.headers.get('x-osm-cache'));

// ── 7. OVERPASS_ENDPOINT 格式不對時要說出來，而不是無聲忽略 ────────────────
// 記下每一次 fetch 的網址；要檢查的是「第一台」，因為 stub 讓每台都失敗會一路試到公用伺服器
let seenUrls = [];
globalThis.fetch = async (url) => { seenUrls.push(url); return new Response('x', { status: 429 }); };
globalThis.Deno = { env: { get: () => 'api.overpass.ch/v1/KEY/interpreter' } };   // 少了 https://
res = await handler(makeReq(), { ip: '7.7.7.7' });
body = await res.json();
check('格式不對時標示未使用金鑰', res.headers.get('x-osm-keyed') === 'no', res.headers.get('x-osm-keyed'));
check('格式不對時診斷有說明原因', /unusable/.test(body.config || ''), JSON.stringify(body.config));
check('說明不含金鑰值', !/KEY|overpass\.ch/.test(body.config || ''), JSON.stringify(body.config));

// ── 8. 值前後有空白／換行（手機貼值常見）仍要能用 ──────────────────────────
globalThis.Deno = { env: { get: () => '  https://api.overpass.ch/v1/KEY/interpreter\n' } };
seenUrls = [];
res = await handler(makeReq(), { ip: '8.8.8.8' });
check('前後空白被去掉後視為有效', res.headers.get('x-osm-keyed') === 'yes', res.headers.get('x-osm-keyed'));
check('送往上游的網址不含空白或換行', seenUrls[0] === 'https://api.overpass.ch/v1/KEY/interpreter',
  JSON.stringify(seenUrls[0]));
// ── 9. 角括號佔位符號沒刪掉（實際踩到的狀況）──────────────────────────────
// overpass.ch 只會回一句 malformed API key，看不出是自己的值有問題，所以要在本層講明白。
globalThis.Deno = { env: { get: k =>
  k === 'OVERPASS_ENDPOINT' ? 'https://api.overpass.ch/v1/<你的金鑰>/interpreter' : '' } };
seenUrls = [];
res = await handler(makeReq(), { ip: '9.9.9.9' });
body = await res.json();
check('角括號未刪時不送出，直接說明原因', /placeholder brackets/.test(body.config || ''),
  JSON.stringify(body.config));
check('角括號未刪時不當成已設金鑰', res.headers.get('x-osm-keyed') === 'no', res.headers.get('x-osm-keyed'));
check('角括號未刪時不會把壞網址送上游',
  seenUrls.every(u => !/overpass\.ch/.test(u)), JSON.stringify(seenUrls));

// ── 10. 標頭式金鑰：只送給設定的端點，絕不外流到公用伺服器 ──────────────────
let seenCalls = [];
globalThis.fetch = async (url, opts) => {
  seenCalls.push({ url, key: (opts.headers || {})['x-api-key'] || null });
  return new Response('x', { status: 429 });   // 逼它一路試到公用伺服器
};
globalThis.Deno = { env: { get: k => k === 'OVERPASS_API_KEY' ? 'SECRET123' : '' } };
res = await handler(makeReq(), { ip: '10.10.10.10' });
check('只設金鑰時自動用 overpass.ch 端點', /api\.overpass\.ch/.test(seenCalls[0].url), seenCalls[0].url);
check('金鑰以 X-API-Key 標頭送出', seenCalls[0].key === 'SECRET123', seenCalls[0].key);
check('金鑰絕不送往公用伺服器',
  seenCalls.filter(c => !/api\.overpass\.ch/.test(c.url)).every(c => c.key === null),
  JSON.stringify(seenCalls.map(c => (c.key ? 'KEY→' : 'none→') + new URL(c.url).host)));
delete globalThis.Deno;

// ── 11. 來源限制：共用代查不能是開放代理 ──────────────────────────────────
// 重點是「不允許的來源不會打到上游」—— 光靠 CORS 標頭擋，請求照樣消耗額度。
let upstreamCalls = 0;
globalThis.fetch = async () => { upstreamCalls++; return new Response(
  JSON.stringify({ elements: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };

const withOrigin = (o) => new Request('https://eco4design.healsdesign.org/api/osm', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o ? { origin: o } : {}) },
  body: 'data=' + encodeURIComponent(QUERY.replace('24.77', `24.${50 + (n++)}`)),
});

const probe = async (o) => {
  const before = upstreamCalls;
  const r = await handler(withOrigin(o), { ip: '11.11.11.' + (n % 200) });
  return { status: r.status, acao: r.headers.get('access-control-allow-origin'),
           expose: r.headers.get('access-control-expose-headers'),
           hitUpstream: upstreamCalls > before };
};

let p = await probe('https://map.healsdesign.org');
check('自家網域（基地分析工作站）放行', p.status === 200, JSON.stringify(p));
check('放行時回對應的 origin 而非 *', p.acao === 'https://map.healsdesign.org', p.acao);
check('x-osm-* 標頭宣告為跨來源可讀（否則別站讀到的全是 null）',
  /x-osm-source/.test(p.expose || '') && /x-osm-keyed/.test(p.expose || '') && /x-osm-cache/.test(p.expose || ''),
  p.expose);

p = await probe('https://zoning8circulation.healsdesign.org');
check('自家網域（分區與動線）放行', p.status === 200, JSON.stringify(p));

p = await probe('https://evil.example.com');
check('陌生網域擋下（403）', p.status === 403, JSON.stringify(p));
check('陌生網域「不會」打到上游，額度不被吃', p.hitUpstream === false, JSON.stringify(p));
check('擋下時不回 CORS 放行標頭', p.acao === null, p.acao);

p = await probe('https://evilhealsdesign.org');
check('相似網域不會誤放（evilhealsdesign.org）', p.status === 403, JSON.stringify(p));

p = await probe('http://localhost:5173');
check('本機開發放行', p.status === 200, JSON.stringify(p));

p = await probe(null);
check('沒有 Origin 的呼叫放行（交給速率限制）', p.status === 200, JSON.stringify(p));

// netlify.app 站台靠環境變數加入
// 小布路書沒有自訂網域，已寫進預設清單
p = await probe('http://cycling-roadbook.netlify.app');
check('小布路書（netlify.app）預設放行', p.status === 200, JSON.stringify(p));
p = await probe('https://main--cycling-roadbook.netlify.app');
check('同站的分支部署網址也放行', p.status === 200, JSON.stringify(p));
p = await probe('https://evilcycling-roadbook.netlify.app');
check('別人註冊的相似站名不會誤放', p.status === 403, JSON.stringify(p));

// 環境變數用於臨時追加，不必改程式
p = await probe('https://extra-site.netlify.app');
check('未列入的其他站台擋下', p.status === 403, JSON.stringify(p));
globalThis.Deno = { env: { get: k => k === 'OSM_ALLOWED_ORIGINS' ? ' extra-site.netlify.app ' : '' } };
p = await probe('https://extra-site.netlify.app');
check('環境變數追加後放行', p.status === 200, JSON.stringify(p));
delete globalThis.Deno;

// ── 12. GET ?data= 也要支援（基地分析工作站就是這樣呼叫 Overpass 的）────────
// 代查要能當上游的等價替代品，各站才只需換端點常數，不必改查詢組裝邏輯。
let getSeen = null;
globalThis.fetch = async (url, opts) => {
  getSeen = { url, method: opts.method, body: opts.body };
  return new Response(JSON.stringify({ elements: [{ type: 'way', id: 3 }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const gq = QUERY.replace('24.77', '23.11');   // 用前面測試都沒用過的座標，避免撞到模組內的快取
let gres = await handler(new Request(
  'https://eco4design.healsdesign.org/api/osm?data=' + encodeURIComponent(gq),
  { method: 'GET', headers: { origin: 'https://map.healsdesign.org' } }), { ip: '12.12.12.12' });
let gbody = await gres.json();
check('GET ?data= 回 200（且非快取）', gres.status === 200 && gres.headers.get('x-osm-cache') === 'miss',
  gres.status + ' / ' + gres.headers.get('x-osm-cache'));
check('GET 也回傳上游資料', Array.isArray(gbody.elements) && gbody.elements.length === 1, JSON.stringify(gbody));
check('GET 收到的查詢已正確解碼', getSeen.body === 'data=' + encodeURIComponent(gq), String(getSeen.body).slice(0, 60));
check('不論前端用 GET，轉給上游一律用 POST', getSeen.method === 'POST', getSeen.method);

gres = await handler(new Request('https://eco4design.healsdesign.org/api/osm?data=' + encodeURIComponent(gq),
  { method: 'GET', headers: { origin: 'https://evil.example.com' } }), { ip: '12.12.12.13' });
check('GET 同樣受來源限制', gres.status === 403, gres.status);

gres = await handler(new Request('https://eco4design.healsdesign.org/api/osm?data=nonsense',
  { method: 'GET' }), { ip: '12.12.12.14' });
check('GET 的查詢同樣要通過格式檢查', gres.status === 400, gres.status);

gres = await handler(new Request('https://eco4design.healsdesign.org/api/osm',
  { method: 'DELETE' }), { ip: '12.12.12.15' });
check('其他方法仍回 405', gres.status === 405, gres.status);

// GitHub Pages 來源（基地分析工作站的第二個部署位置）
globalThis.fetch = async () => new Response(JSON.stringify({ elements: [] }),
  { status: 200, headers: { 'content-type': 'application/json' } });
gres = await handler(new Request('https://eco4design.healsdesign.org/api/osm?data=' + encodeURIComponent(QUERY.replace('24.77','23.12')),
  { method: 'GET', headers: { origin: 'https://cyckaper.github.io' } }), { ip: '12.12.12.16' });
check('GitHub Pages 來源放行', gres.status === 200, gres.status);

globalThis.fetch = realFetch;
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

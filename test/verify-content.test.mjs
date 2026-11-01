// /api/verify 的內容取回測試
//   node test/verify-content.test.mjs
// 不需要網路：以 stub 取代 fetch，實際執行 edge function 的 handler。
//
// 為什麼這些測試存在：
// 參考文獻查核的判定會把「查無、不相符、無法確認」的來源，連同引用它們的段落
// 一起從報告裡刪掉。只比對題名時，「題名相符、內容無關」的引用會過關，
// 而真實但題名寫法不同的文獻會被誤刪。因此查核要取回內容——
// Crossref／OpenAlex 的摘要、網頁的主要內文——供後續判讀是否真的支持該主張。
//
// 這個檔案測的是「內容確實被取回並正確標示出處」，不是判讀本身。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'netlify', 'edge-functions', 'verify.js');
const mod = await import('data:text/javascript;base64,' +
  Buffer.from(readFileSync(SRC, 'utf8')).toString('base64'));
const handler = mod.default;

const PASSCODE = 'test-passcode';
globalThis.Deno = { env: { get: k => (k === 'QI_PASSCODE' ? PASSCODE : '') } };

const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

let ipCounter = 0;
async function run(refs, stubs) {
  // 每個案例換一個 IP：同一執行個體內有速率限制，整檔跑下來會撞到
  const ip = `10.0.${++ipCounter}.1`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [pattern, make] of stubs) {
      if (u.includes(pattern)) return make(u);
    }
    return new Response('not found', { status: 404 });
  };
  const res = await handler(new Request('https://eco4design.healsdesign.org/api/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: PASSCODE, lang: 'zh', refs }),
  }), { ip });
  const text = await res.text();
  const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  return { status: res.status, lines, byId: new Map(lines.filter(l => l.id).map(l => [l.id, l])) };
}

const json = (obj, status = 200) => () => new Response(JSON.stringify(obj),
  { status, headers: { 'content-type': 'application/json' } });
const html = (body, status = 200) => () => new Response(body,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

const DOI = '10.1016/j.landurbplan.2019.103660';
const TITLE = 'Green space and mental health in urban residents';
const handleOk = ['doi.org/api/handles', json({ responseCode: 1, values: [] })];

const absOf = (r) => {
  const c = (r.checks || []).find(x => x.foundAbstract);
  return c ? { text: c.foundAbstract, src: c.abstractSource } : null;
};

// ── 1. Crossref 的 abstract 是 JATS XML ───────────────────────────────────
{
  const JATS = '<jats:p><jats:title>Background</jats:title>Urban residents face rising stress. '
    + 'We examined whether access to green space predicts lower psychological distress across 42 neighbourhoods.</jats:p>';
  const r = await run([{ id: 'a', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] }, abstract: JATS } })],
  ]);
  const a = absOf(r.byId.get('a'));
  check('Crossref 的 JATS 摘要有取回', !!a, JSON.stringify(r.byId.get('a')));
  check('JATS 標籤已去除', !!a && !/<|jats:/.test(a.text), a && a.text.slice(0, 80));
  check('章節標題與內文沒有黏成一句', !!a && /Background:\s*Urban/.test(a.text), a && a.text.slice(0, 60));
  check('出處標為 Crossref', !!a && a.src === 'Crossref', a && a.src);
}

// ── 2. Crossref 沒有摘要時，要去 OpenAlex 補 ──────────────────────────────
// Crossref 有大量文獻沒繳摘要，OpenAlex 覆蓋率高得多。少了這條路，
// 多數文獻就只剩題名可比，等於沒改善。
{
  let oaCalled = false;
  const inverted = { Urban: [0], green: [1], space: [2], reduces: [3], measured: [4],
    psychological: [5], distress: [6], across: [7], 'forty-two': [8], neighbourhoods: [9],
    in: [10], a: [11], cross: [12], sectional: [13], survey: [14], of: [15], adults: [16] };
  const r = await run([{ id: 'b', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] } } })],
    ['api.openalex.org', (u) => { oaCalled = true; return json({ doi: 'https://doi.org/' + DOI,
      title: TITLE, display_name: TITLE, publication_year: 2019,
      abstract_inverted_index: inverted })(u); }],
  ]);
  const a = absOf(r.byId.get('b'));
  check('Crossref 無摘要時會去問 OpenAlex', oaCalled, 'OpenAlex 未被呼叫');
  check('OpenAlex 的 inverted index 已還原成文字', !!a && /Urban green space reduces/.test(a.text), a && a.text);
  check('還原的詞序正確（依位置排列）', !!a && a.text.startsWith('Urban green space reduces measured'), a && a.text.slice(0, 50));
  check('出處誠實標為 OpenAlex（不是 Crossref）', !!a && a.src === 'OpenAlex', a && a.src);
}

// ── 3. 兩邊都沒有摘要：不應憑空生出內容 ──────────────────────────────────
{
  const r = await run([{ id: 'c', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] } } })],
    ['api.openalex.org', json({ doi: 'https://doi.org/' + DOI, title: TITLE, publication_year: 2019 })],
  ]);
  check('沒有摘要時欄位留空，不編造', absOf(r.byId.get('c')) === null, JSON.stringify(absOf(r.byId.get('c'))));
}

// ── 4. 太短的摘要殘骸要當成沒有 ──────────────────────────────────────────
{
  const r = await run([{ id: 'd', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] },
      abstract: '<jats:p>Abstract</jats:p>' } })],
    ['api.openalex.org', json({}, 404)],
  ]);
  check('只有 "Abstract" 一個字不算摘要', absOf(r.byId.get('d')) === null, JSON.stringify(absOf(r.byId.get('d'))));
}

// ── 5. 網頁來源：citation_abstract 優先 ──────────────────────────────────
{
  const page = `<html><head><title>${TITLE}</title>
    <meta name="citation_title" content="${TITLE}">
    <meta name="citation_abstract" content="We surveyed 1,200 urban adults and found that residential green space was associated with lower distress scores.">
    <meta name="description" content="Journal homepage.">
    </head><body><nav>Home About Contact</nav><p>Short.</p></body></html>`;
  const r = await run([{ id: 'e', text: `${TITLE}. 2019.`, dois: [], urls: ['https://example.org/article'] }], [
    ['example.org', html(page)],
  ]);
  const a = absOf(r.byId.get('e'));
  check('網頁的 citation_abstract 有取回', !!a && /1,200 urban adults/.test(a.text), a && a.text);
  check('網頁摘要出處標為 citation_abstract', !!a && a.src === 'citation_abstract', a && a.src);
}

// ── 6. 網頁沒有摘要欄位 → 抽主要內文，且要跳過選單 ──────────────────────
{
  const page = `<html><head><title>${TITLE}</title>
    <meta name="citation_title" content="${TITLE}"></head><body>
    <nav>首頁 關於我們 聯絡資訊 網站導覽</nav>
    <div>回首頁</div>
    <p>本研究以四十二個里為單位，檢視居住環境綠地可及性與居民心理困擾程度之關聯。
    結果顯示綠地覆蓋率每增加一成，心理困擾分數平均下降零點三分。</p>
    <footer>版權所有</footer></body></html>`;
  const r = await run([{ id: 'f', text: `${TITLE}. 2019.`, dois: [], urls: ['https://example.org/zh/article'] }], [
    ['example.org', html(page)],
  ]);
  const a = absOf(r.byId.get('f'));
  check('沒有摘要欄位時會抽頁面內文', !!a && /四十二個里/.test(a.text), a && a.text);
  check('內文出處標為 page_text', !!a && a.src === 'page_text', a && a.src);
  check('頁首選單沒有被當成內文', !!a && !/網站導覽/.test(a.text), a && a.text.slice(0, 60));
}

// ── 7. 內容不得超長，也不得洩漏頁面原始 HTML ────────────────────────────
{
  const long = 'This sentence describes the study design in detail and is deliberately verbose. '.repeat(200);
  const page = `<html><head><title>${TITLE}</title>
    <meta name="citation_title" content="${TITLE}"></head><body><p>${long}</p>
    <script>var secret = "should-never-appear";</script></body></html>`;
  const r = await run([{ id: 'g', text: `${TITLE}. 2019.`, dois: [], urls: ['https://example.org/long'] }], [
    ['example.org', html(page)],
  ]);
  const a = absOf(r.byId.get('g'));
  check('內文長度受上限約束（≤ 1500）', !!a && a.text.length <= 1500, a && a.text.length);
  check('不含標籤或 script 內容', !!a && !/<|should-never-appear/.test(a.text), a && a.text.slice(0, 80));
}

// ── 8. 惡意／畸形的 inverted index 不能把 CPU 預算吃光或拋錯 ─────────────
{
  const hostile = {};
  for (let i = 0; i < 20000; i++) hostile['w' + i] = [i, i + 1, -5, 1e9, null];
  hostile.__proto__x = 'x';
  const r = await run([{ id: 'h', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] } } })],
    ['api.openalex.org', json({ doi: 'https://doi.org/' + DOI, title: TITLE, publication_year: 2019,
      abstract_inverted_index: hostile })],
  ]);
  const got = r.byId.get('h');
  const a = absOf(got);
  check('兩萬個詞的畸形索引不會拋錯', !!got && typeof got.verdict === 'string', JSON.stringify(got && got.verdict));
  check('畸形索引的結果仍受長度上限', !a || a.text.length <= 1500, a && a.text.length);
}

// ── 9. 既有行為沒被改壞：捏造的 DOI 仍判為查無 ───────────────────────────
{
  const r = await run([{ id: 'i', text: 'A fabricated paper that does not exist. 2023.',
    dois: ['10.9999/not-a-real-doi'], urls: [] }], [
    ['doi.org/api/handles', json({ responseCode: 100 })],
    ['api.crossref.org', json({}, 404)],
    ['api.openalex.org', json({}, 404)],
  ]);
  const got = r.byId.get('i');
  check('未註冊的 DOI 仍判為 not_found（學術嚴謹度底線）',
    !!got && got.verdict === 'not_found', got && got.verdict);
}

// ── 10. 串流格式仍正確（最後一行帶 stats）────────────────────────────────
{
  const r = await run([{ id: 'j', text: `${TITLE}. 2019.`, dois: [DOI], urls: [] }], [
    handleOk,
    ['api.crossref.org', json({ message: { DOI, title: [TITLE], issued: { 'date-parts': [[2019]] },
      abstract: '<jats:p>A sufficiently long abstract describing the methods and the main finding of the study.</jats:p>' } })],
  ]);
  const last = r.lines[r.lines.length - 1];
  check('最後一行是 done 與 stats', !!last && last.done === true && !!last.stats, JSON.stringify(last));
  check('回應為 200', r.status === 200, r.status);
}

// ── 11. ASP.NET WebForms：整頁內容包在 <form> 裡 ─────────────────────────
// 臺灣政府網站大量使用 WebForms。若把 <form> 當成非內文區塊砍掉，內文會整個消失。
{
  const page = `<html><head><title>${TITLE}</title>
    <meta name="citation_title" content="${TITLE}"></head><body>
    <form method="post" action="./Default.aspx" id="form1">
    <div class="aspNetHidden"><input type="hidden" name="__VIEWSTATE" value="aaaaaaaaaaaa"></div>
    <nav>回首頁 網站導覽 雙語詞彙</nav>
    <div id="content"><p>本計畫調查全國三十處環境教育場域的承載量，
    發現週末時段的到訪人次平均超出設計容量約兩成五，且與鄰近綠地面積呈負相關。</p></div>
    <footer>本網站由環境部維護</footer></form></body></html>`;
  const r = await run([{ id: 'k', text: `${TITLE}. 2019.`, dois: [], urls: ['https://example.org/gov/Default.aspx'] }], [
    ['example.org', html(page)],
  ]);
  const a = absOf(r.byId.get('k'));
  check('WebForms 頁面（內容在 <form> 裡）仍抽得到內文', !!a && /三十處環境教育場域/.test(a.text), a && a.text);
  check('WebForms 頁面的選單與頁尾沒被當成內文',
    !!a && !/網站導覽/.test(a.text) && !/環境部維護/.test(a.text), a && a.text.slice(0, 80));
  check('__VIEWSTATE 之類的隱藏欄位沒有混進內文', !!a && !/VIEWSTATE|aaaaaa/.test(a.text), a && a.text.slice(0, 80));
}

globalThis.fetch = undefined;
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

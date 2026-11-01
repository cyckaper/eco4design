// PDF 內文抽取（netlify/functions/pdf-text.mjs）
//   node test/pdf-text.test.mjs
// 需要 node_modules（unpdf）：先在 repo 根目錄 npm install。
//
// 為什麼這些測試存在：
// 這段程式的輸出會被送去判讀「文獻是否支持主張」，而那個判讀會把來源連同引用它的
// 段落從報告裡刪掉。所以最重要的性質不是「抽得多」，而是「解不出來時不吐亂碼」——
// 亂碼會造成錯誤的刪除，比抽不到更糟。
//
// 另外這個端點會代為連線任意網址，所以通行碼、來源限制與 SSRF 防護都要有測試。
//
// fixtures 以 reportlab 產生，內嵌 TrueType 子集並帶 ToUnicode CMap，結構與真實
// 政府 PDF 同類；cid_notounicode.pdf 是「解不出來」的那一類（pdftotext 對它也只抽到 6 字元）。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'test', 'fixtures');

const results = [];
let failed = 0;
const check = (name, pass, got) => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        got: ${got}`}`);
  if (!pass) failed++;
};

const PASSCODE = 'test-passcode';
process.env.QI_PASSCODE = PASSCODE;

let mod;
try {
  mod = await import(pathToFileURL(join(ROOT, 'netlify', 'functions', 'pdf-text.mjs')).href);
} catch (e) {
  console.log('FAIL  載入 pdf-text.mjs（是否已 npm install？）\n        ' + String(e.message || e));
  process.exit(1);
}
const { default: handler, extractPdfText, quality } = mod;

const bytesOf = f => new Uint8Array(readFileSync(join(FIX, f)));

// ── 1. 抽取本身：中文、英文、濾鏡鏈、大檔 ───────────────────────────────
{
  const zh = await extractPdfText(bytesOf('flate_zh.pdf'));
  check('中文 PDF 抽得到內文', zh.kind === 'page' && zh.text.length > 500,
    JSON.stringify({ kind: zh.kind, none: zh.none, len: (zh.text || '').length }));
  check('抽出的是真的中文（關鍵詞正確）', /環境教育場域|承載量/.test(zh.text || ''), (zh.text || '').slice(0, 60));
  const han = ((zh.text || '').match(/\p{Script=Han}/gu) || []).length;
  check(`漢字佔比合理（${(han / Math.max(1, (zh.text || '').length)).toFixed(2)}）`,
    han / Math.max(1, (zh.text || '').length) > 0.7, han);

  const en = await extractPdfText(bytesOf('flate_en.pdf'));
  check('英文 PDF 抽得到內文', en.kind === 'page' && /carrying capacity/.test(en.text || ''),
    JSON.stringify({ kind: en.kind, none: en.none, len: (en.text || '').length }));

  const chain = await extractPdfText(bytesOf('zh_embed.pdf'));
  check('ASCII85＋Flate 濾鏡鏈也能解', chain.kind === 'page' && /環境教育場域|承載量/.test(chain.text || ''),
    JSON.stringify({ kind: chain.kind, none: chain.none }));

  const big = await extractPdfText(bytesOf('flate_big.pdf'));
  check('40 頁的大檔抽得到內文', big.kind === 'page' && big.text.length > 500,
    JSON.stringify({ kind: big.kind, none: big.none, len: (big.text || '').length }));
  check('輸出有上限（不會把整份報告塞進判讀）', (big.text || '').length <= 6000, (big.text || '').length);
}

// ── 2. 最要緊的性質：解不出來時不吐亂碼 ─────────────────────────────────
{
  const r = await extractPdfText(bytesOf('cid_notounicode.pdf'));
  check('沒有 ToUnicode 的中文 PDF 回報抽不到，而不是亂碼',
    !r.kind && typeof r.none === 'string', JSON.stringify({ kind: r.kind, none: r.none, head: (r.text || '').slice(0, 50) }));

  const rnd = new Uint8Array(40000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) % 256;
  const r2 = await extractPdfText(rnd);
  check('非 PDF 的位元組被擋下', r2.none === 'not_pdf', JSON.stringify(r2));

  const trunc = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]);
  const r3 = await extractPdfText(trunc);
  check('只有檔頭的截斷 PDF 不會拋錯', !!r3.none, JSON.stringify(r3));
}

// ── 3. 品質閘門（縱深防護）─────────────────────────────────────────────
{
  check('純空白被擋', quality('   '.repeat(100)) !== null, quality('   '.repeat(100)));
  check('同一字元重複被擋', quality('阿'.repeat(300)) === 'pdf_garbled', quality('阿'.repeat(300)));
  check('替代字元過多被擋', quality('本研究' + '�'.repeat(50) + '環境教育'.repeat(30)) === 'pdf_garbled',
    quality('本研究' + '�'.repeat(50) + '環境教育'.repeat(30)));
  const latinNoise = Array.from({ length: 300 }, (_, i) => String.fromCharCode(65 + (i * 7) % 26)).join('');
  check('無詞界的拉丁雜訊被擋', quality(latinNoise) === 'pdf_garbled', quality(latinNoise));
  const realZh = '本計畫調查全國三十處環境教育場域之承載量，發現週末時段到訪人次平均超出設計容量約兩成五。'.repeat(3);
  check('正常中文通過', quality(realZh) === null, quality(realZh));
  const realEn = 'This report surveys carrying capacity at thirty environmental education sites nationwide and finds that weekend visitor numbers exceed design capacity by about twenty five percent on average across the sampled period.';
  check('正常英文通過', quality(realEn) === null, quality(realEn));
}

// ── 4. 端點：通行碼、來源限制、SSRF ────────────────────────────────────
{
  const post = (body, headers) => handler(new Request('https://eco4design.healsdesign.org/api/pdf-text', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  }));
  const bodyOf = async r => { try { return JSON.parse(await r.text()); } catch (_) { return null; } };

  let r = await handler(new Request('https://eco4design.healsdesign.org/api/pdf-text', { method: 'GET' }));
  check('GET 回 405', r.status === 405, r.status);

  r = await post({ url: 'https://example.org/a.pdf' });
  check('沒有通行碼回 401', r.status === 401, r.status);

  r = await post({ passcode: 'wrong', url: 'https://example.org/a.pdf' });
  check('通行碼錯誤回 401', r.status === 401, r.status);

  r = await post({ passcode: PASSCODE, url: 'https://example.org/a.pdf' }, { origin: 'https://evil.example.com' });
  check('陌生來源回 403', r.status === 403, r.status);

  r = await post({ passcode: PASSCODE, url: 'https://example.org/a.pdf' }, { origin: 'https://map.healsdesign.org' });
  check('自家來源不被擋（非 403）', r.status !== 403, r.status);

  for (const [label, u] of [
    ['localhost', 'http://localhost/x.pdf'],
    ['127.0.0.1', 'http://127.0.0.1:8080/x.pdf'],
    ['內網 10.x', 'http://10.0.0.5/x.pdf'],
    ['內網 192.168.x', 'http://192.168.1.1/x.pdf'],
    ['雲端中繼資料 169.254.x', 'http://169.254.169.254/latest/meta-data/'],
    ['file://', 'file:///etc/passwd'],
  ]) {
    const res = await post({ passcode: PASSCODE, url: u });
    const b = await bodyOf(res);
    check(`SSRF 防護擋下 ${label}`, res.status === 400 && /blocked_host|bad_scheme|bad_url/.test((b && b.none) || ''),
      res.status + ' ' + JSON.stringify(b));
  }
}

console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

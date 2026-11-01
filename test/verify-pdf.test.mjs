// PDF 內文抽取（verify.js 的 mode: 'abstract' 遇到 PDF）
//   node test/verify-pdf.test.mjs
// 不需要網路：stub fetch 回傳 test/fixtures 下的 PDF，實際執行 handler。
//
// 為什麼這些測試存在：
// 政府報告、年報、計畫成果多為 PDF，沒有這一層那些文獻就沒有內容可比對。
// 但這段程式有兩個互相拉扯的風險，每一條測試都對著其中之一：
//
//   CPU。平台每次請求上限 50 ms。大 PDF 若不早退就會撞上限，
//   而且是整個請求被中止、不只是這一筆失敗。
//
//   亂碼。抽出亂碼比抽不到更糟：它會被送去判讀「文獻是否支持主張」，
//   可能害正確的引用被誤刪。所以寧可回報抽不到。
//
// fixtures 以 reportlab 產生，內嵌 TrueType 子集並帶 ToUnicode CMap，
// 結構與真實政府 PDF 同類；對照答案取自 pdftotext。
import { readFileSync, existsSync } from 'node:fs';
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
globalThis.Deno = { env: { get: k => (k === 'QI_PASSCODE' ? PASSCODE : '') } };
const verify = (await import(pathToFileURL(join(ROOT, 'netlify', 'edge-functions', 'verify.js')).href)).default;

let ipN = 0;
async function abstractOf(file, bytesOverride) {
  const bytes = bytesOverride || new Uint8Array(readFileSync(join(FIX, file)));
  globalThis.fetch = async () => new Response(bytes,
    { status: 200, headers: { 'content-type': 'application/pdf' } });
  const t0 = Date.now();
  const res = await verify(new Request('https://eco4design.healsdesign.org/api/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: PASSCODE, lang: 'zh', mode: 'abstract',
      items: [{ id: 'p', urls: ['https://example.gov.tw/report.pdf'], dois: [], title: '報告' }] }),
  }), { ip: `10.4.${++ipN}.1` });
  let j = null;
  try { j = JSON.parse(await res.text()); } catch (_) {}
  const r = (j && j.results && j.results[0]) || {};
  return { status: res.status, kind: r.kind, text: r.text || '', note: r.note, ms: Date.now() - t0 };
}

for (const f of ['flate_zh.pdf', 'flate_big.pdf', 'flate_en.pdf', 'zh_embed.pdf']) {
  if (!existsSync(join(FIX, f))) { check(`fixture 存在：${f}`, false, '缺檔'); }
}

// ── 1. 中文 PDF（內嵌子集＋ToUnicode）────────────────────────────────────
{
  const r = await abstractOf('flate_zh.pdf');
  check('中文 PDF 抽得到內文', r.kind === 'page' && r.text.length > 200,
    JSON.stringify({ kind: r.kind, len: r.text.length, note: r.note }));
  check('抽出的是真的中文，不是字符編號', /環境教育場域|承載量/.test(r.text), r.text.slice(0, 80));
  // 與 pdftotext 的對照答案比對（只比開頭的特徵詞，排版換行兩者本就不同）
  const exp = readFileSync(join(FIX, 'flate_zh.expected.txt'), 'utf8');
  const probe = (exp.match(/[一-鿿]{6,}/) || [''])[0];
  check(`與 pdftotext 的對照答案一致（特徵詞「${probe}」）`,
    !!probe && r.text.includes(probe), r.text.slice(0, 80));
}

// ── 2. 英文 PDF（簡單字型，無 ToUnicode）────────────────────────────────
{
  const r = await abstractOf('flate_en.pdf');
  check('英文 PDF 抽得到內文', r.kind === 'page' && r.text.length > 200,
    JSON.stringify({ kind: r.kind, len: r.text.length, note: r.note }));
  check('英文內容正確', /carrying capacity/.test(r.text), r.text.slice(0, 80));
}

// ── 3. ASCII85 ＋ FlateDecode 濾鏡鏈 ─────────────────────────────────────
// 盲目 inflate 會全軍覆沒；必須先讀字典的 /Filter 再依序套用。
{
  const r = await abstractOf('zh_embed.pdf');
  check('ASCII85＋Flate 濾鏡鏈也能解', r.kind === 'page' && /環境教育場域|承載量/.test(r.text),
    JSON.stringify({ kind: r.kind, len: r.text.length, note: r.note }));
}

// ── 4. 大 PDF 要早退：成本不隨頁數膨脹 ──────────────────────────────────
// 不早退的話 40 頁要 33 ms，離平台 50 ms 上限太近；早退後約 13 ms。
{
  const small = await abstractOf('flate_zh.pdf');
  const big = await abstractOf('flate_big.pdf');
  check('大 PDF（40 頁）仍抽得到內文', big.kind === 'page' && big.text.length > 200,
    JSON.stringify({ kind: big.kind, len: big.text.length, note: big.note }));
  check(`大檔成本未隨頁數膨脹（小 ${small.ms}ms / 大 ${big.ms}ms，須 < 3 倍）`,
    big.ms < Math.max(small.ms * 3, 300), `${small.ms} → ${big.ms}`);
}

// ── 5. 品質閘門：亂碼與非 PDF 一律回報抽不到 ────────────────────────────
{
  // 隨機位元組（偽裝成 PDF 的 content-type）
  const rnd = new Uint8Array(40000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) % 256;
  const r1 = await abstractOf(null, rnd);
  check('亂數位元組不會被當成內文', r1.kind !== 'page' && !r1.text,
    JSON.stringify({ kind: r1.kind, len: r1.text.length, note: r1.note }));

  // 最危險的一類：CID 字型但沒有 ToUnicode CMap（未內嵌字型的中文 PDF）。
  // 沒有對照表時，字符編號有不少落在可見 ASCII 範圍，會被解成一串隨機英文字母——
  // 看起來「有文字」，實際完全不是文件內容。pdftotext 對這個檔也只抽得到 6 個字元。
  {
    const r2 = await abstractOf('cid_notounicode.pdf');
    check('沒有 ToUnicode 的中文 PDF 不輸出亂碼（回報抽不到）',
      r2.kind !== 'page' && !r2.text,
      JSON.stringify({ kind: r2.kind, len: r2.text.length, note: r2.note, head: r2.text.slice(0, 60) }));
  }

  // 空檔與截斷檔
  const r3 = await abstractOf(null, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  check('只有檔頭的截斷 PDF 不會拋錯', r3.status === 200 && r3.kind !== 'page',
    JSON.stringify({ status: r3.status, kind: r3.kind, note: r3.note }));
}

globalThis.fetch = undefined;
console.log(results.join('\n'));
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);

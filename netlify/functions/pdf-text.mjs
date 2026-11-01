// 棲共生 · PDF 內文抽取（Netlify Function / Node）
//
// 為什麼不放 Edge Function：
// Edge 每次請求只有 50 ms CPU，而解析一份 PDF 要 100 ms 上下。先前在 Edge 裡手寫解析器，
// 連續四輪都是 50 ms 的天花板從不同地方頂回來（逐串流解碼量、ToUnicode 的解析順序、
// 物件查找，最後是「把 1.5 MB 解碼成字串」本身），一度衝到 73 ms——
// 而超支會中止「整個請求」、不只這一筆。Node 執行環境是秒級 CPU，才是這件事該待的地方。
//
// 為什麼用 pdf.js（unpdf）而不是自己寫：
// PDF 1.5 之後字型字典存在壓縮的物件串流裡，原始位元組搜不到 /ToUnicode；
// 要正確處理得實作交叉參考串流、物件串流與物件圖解析。更重要的是，
// 手寫版在「解不出來」時會吐出亂碼——亂碼會被送去判讀「文獻是否支持主張」，
// 可能害正確的引用被誤刪。pdf.js 在解不出來時回空值（實測與 pdftotext 一致）。
//
// 請求（POST JSON）：{ passcode, url }
// 回應：{ kind: 'page', text, src } 或 { none: <原因代碼> }
//
// 環境變數：QI_PASSCODE（必填，與 analyze／verify 共用；未設定時本端點不開放）

const MAX_BYTES = 12 * 1024 * 1024;     // 下載上限：政府報告動輒數 MB，但不接受無上限
const FETCH_TIMEOUT_MS = 20000;
const PARSE_TIMEOUT_MS = 20000;
const MAX_PAGES = 12;                   // 只看前幾頁：摘要與前言都在最前面
const OUT_MAX = 6000;
const MIN_CHARS = 120;
const UA = 'Qi-Coexistence-RefCheck/1.0 (+https://eco4design.healsdesign.org)';

// 只允許自家站台呼叫（與 /api/osm 相同規則）。hostname 比對、不管連接埠；
// '*.' 開頭是子網域通配；其餘精確比對，並額外接受 Netlify 分支部署網址
// （main--站名.netlify.app）——以 '--' 為界，別人註冊 xx站名.netlify.app 不會被放行。
const ALLOWED_ORIGINS = ['*.healsdesign.org', 'cycling-roadbook.netlify.app', 'cyckaper.github.io'];
const DEV_HOSTNAMES = ['localhost', '127.0.0.1'];

function originRejected(origin) {
  if (!origin) return null;             // 本站 edge function 轉來的請求沒有 Origin
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (_) { return 'malformed'; }
  if (DEV_HOSTNAMES.includes(hostname)) return null;
  const ok = ALLOWED_ORIGINS.some(p => {
    if (p.startsWith('*.')) { const b = p.slice(2); return hostname === b || hostname.endsWith('.' + b); }
    return hostname === p || hostname.endsWith('--' + p);
  });
  return ok ? null : hostname;
}

const json = (status, obj) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// 只抓 http(s)，且不得指向內網：這個端點會代為連線任意網址，必須防 SSRF
function badUrl(u) {
  let x;
  try { x = new URL(u); } catch (_) { return 'bad_url'; }
  if (!/^https?:$/.test(x.protocol)) return 'bad_scheme';
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1') return 'blocked_host';
  if (/^(?:10|127)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return 'blocked_host';
  if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return 'blocked_host';
  if (!h.includes('.')) return 'blocked_host';
  return null;
}

// 品質閘門。pdf.js 解不出來時已經回空值，這一層是縱深防護：
// 萬一抽出「看起來像文字、其實是字符編號」的東西，寧可回報抽不到。
const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_RE = new RegExp(`[${CJK_CLASS}]`, 'u');

export function quality(text) {
  if (!text || text.length < MIN_CHARS) return 'pdf_short';
  const good = (text.match(new RegExp(`[${CJK_CLASS}A-Za-z0-9]`, 'gu')) || []).length;
  if (good / text.length < 0.55) return 'pdf_garbled';
  if (((text.match(/�/g) || []).length) / text.length > 0.02) return 'pdf_garbled';
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) || 0) + 1);
  if (Math.max(...freq.values()) / text.length > 0.25) return 'pdf_garbled';
  if (CJK_RE.test(text)) {
    const han = (text.match(/\p{Script=Han}/gu) || []).length;
    if (han / text.length < 0.25) return 'pdf_garbled';
  } else if (text.split(/\s+/).filter(w => /^[A-Za-z][A-Za-z'-]+$/.test(w)).length < 20) {
    return 'pdf_garbled';
  }
  return null;
}

async function readCapped(res, cap) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) {
    const b = new Uint8Array(await res.arrayBuffer());
    return b.length > cap ? null : b;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { try { await reader.cancel(); } catch (_) {} return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const withTimeout = (p, ms, code) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(code)), ms)),
]);

// 抽取本身獨立出來，測試才能直接餵位元組、不必經過網路
export async function extractPdfText(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head !== '%PDF-') return { none: 'not_pdf' };
  let text = '';
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const run = (async () => {
      const pdf = await getDocumentProxy(bytes);
      const pages = Math.min(pdf.numPages || MAX_PAGES, MAX_PAGES);
      const parts = [];
      for (let i = 1; i <= pages; i++) {
        const { text: t } = await extractText(pdf, { mergePages: true, pages: [i] });
        parts.push(String(t || ''));
        if (parts.join(' ').length > OUT_MAX * 2) break;   // 夠了就停
      }
      return parts.join(' ');
    })();
    text = await withTimeout(run, PARSE_TIMEOUT_MS, 'parse_timeout');
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/password|encrypt/i.test(m)) return { none: 'pdf_encrypted' };
    if (m === 'parse_timeout') return { none: 'pdf_timeout' };
    return { none: 'pdf_parse_failed' };
  }
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, OUT_MAX);
  if (!clean) return { none: 'pdf_no_text' };
  const q = quality(clean);
  return q ? { none: q } : { kind: 'page', text: clean };
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { none: 'bad_method' });

  const PASSCODE = process.env.QI_PASSCODE;
  if (!PASSCODE) return json(503, { none: 'not_configured' });

  if (originRejected(request.headers.get('origin'))) return json(403, { none: 'origin_not_allowed' });

  let body;
  try { body = await request.json(); } catch (_) { return json(400, { none: 'bad_json' }); }
  if (!body || typeof body !== 'object') return json(400, { none: 'bad_body' });

  const given = typeof body.passcode === 'string' ? body.passcode.trim() : '';
  if (!given) return json(401, { none: 'passcode_required' });
  if (given !== PASSCODE) return json(401, { none: 'passcode_invalid' });

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const bad = badUrl(url);
  if (bad) return json(400, { none: bad });

  let bytes;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/pdf,*/*' },
        signal: ac.signal, redirect: 'follow' });
    } finally { clearTimeout(timer); }
    if (!res.ok) return json(200, { none: 'http_' + res.status });
    bytes = await readCapped(res, MAX_BYTES);
    if (!bytes) return json(200, { none: 'pdf_too_large' });
  } catch (e) {
    return json(200, { none: /abort/i.test(String(e)) ? 'timeout' : 'network_error' });
  }

  const out = await extractPdfText(bytes);
  if (out.none) return json(200, out);
  let host = '';
  try { host = new URL(url).host; } catch (_) {}
  return json(200, { kind: 'page', text: out.text, src: host + ' · PDF' });
};

export const config = { path: '/api/pdf-text' };

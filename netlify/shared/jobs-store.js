// 分析背景工作的儲存與共用小工具（functions/jobs.mjs 與 functions/analyze-bg.mjs 共用）
//
// 為什麼要有背景工作：分析要 3–15 分鐘，原本瀏覽器得一直拉著一條串流連線，手機鎖屏、切 App、換網路
// 就斷，伺服器端已經花掉的時間與 token 也跟著作廢（2026-11-10 早上 Jake 在 iPhone 上 15 分鐘後失敗）。
// 改成：瀏覽器送出請求拿到工作編號 → 背景 Function 跑分析、把串流事件一塊一塊寫進 Netlify Blobs →
// 瀏覽器每幾秒輪詢一次、把拿到的事件餵給同一個解析器；斷線就從上次拿到的那一塊接回去，
// 頁面關掉再開也接得回來（工作編號存在 localStorage）。
//
// 儲存：Netlify Blobs，store 'qi-analysis-jobs'，strong consistency（寫完馬上讀得到）。
//   j/<id>/meta      工作狀態（JSON，見 analyze-bg.mjs 的 meta 欄位）
//   j/<id>/prompt    提示詞全文（背景 Function 從這裡讀，接力續跑時也用）
//   j/<id>/c/000000  第 n 塊 SSE 文字（每塊 ≤ ~32 KB，整數個事件；串起來就是原本瀏覽器會收到的串流）
// 工作編號 = yyyymmdd-<24 hex>：日期在前，清理舊工作時只要看鍵名。

export const STORE_NAME = 'qi-analysis-jobs';
export const JOB_ID_RE = /^\d{8}-[0-9a-f]{24}$/;
export const KEEP_DAYS = 2;                // 完成的工作保留兩天（報告早已存在瀏覽器歷史裡；這只是為了斷線重接）

export const metaKey = id => `j/${id}/meta`;
export const promptKey = id => `j/${id}/prompt`;
export const chunkKey = (id, seq) => `j/${id}/c/${String(seq).padStart(6, '0')}`;

export function newJobId(now = new Date(), rnd = globalThis.crypto) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  const b = new Uint8Array(12); rnd.getRandomValues(b);
  return `${d}-${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`;
}
export const jobDate = id => String(id).slice(0, 8);
export const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// 背景 Function 只接受帶這個密鑰的呼叫（它有 API 金鑰的使用權，不能讓路過的人直接打）。
// 有設 JOB_SECRET 就用它；沒有就從 ANTHROPIC_API_KEY 導出（兩個 Function 讀同一組環境變數，不必多設一個）。
export async function jobSecret(env) {
  if (env.JOB_SECRET) return String(env.JOB_SECRET);
  const data = new TextEncoder().encode('qi-jobs:' + String(env.ANTHROPIC_API_KEY || ''));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}

// 真正的 store 只在 Netlify 上載入（測試傳自己的進來）
export async function openStore(injected) {
  if (injected) return injected;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

// 記憶體版（測試用；介面與 @netlify/blobs 的 Store 一致：get/setJSON/set/delete/list）
export function memoryStore() {
  const m = new Map();
  return {
    _m: m,
    async get(key, opts) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return opts && opts.type === 'json' ? JSON.parse(v) : v;
    },
    async setJSON(key, value) { m.set(key, JSON.stringify(value)); },
    async set(key, value) { m.set(key, String(value)); },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) {
      return { blobs: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key, etag: '' })), directories: [] };
    },
  };
}

// 清掉 KEEP_DAYS 之前的工作（鍵名帶日期，不必讀內容）。呼叫端偶爾（例如每 20 次建立一次）跑一次就夠
export async function cleanupOldJobs(store, now = new Date(), keepDays = KEEP_DAYS) {
  const cutoff = ymd(new Date(now.getTime() - keepDays * 86400000));
  const { blobs } = await store.list({ prefix: 'j/' });
  let n = 0;
  for (const b of blobs) {
    const id = b.key.split('/')[1] || '';
    if (jobDate(id) < cutoff) { await store.delete(b.key); n++; }
  }
  return n;
}

export const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

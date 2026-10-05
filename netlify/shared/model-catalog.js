// 模型目錄（analyze.js 與 models.js 共用）
// 目的：不把模型寫死在程式裡。每次（快取 6 小時）向 Anthropic Models API 取得目前可用的模型，
// 各系列（Opus／Sonnet／Haiku）只取最新一版，並依「分析時間 × token 費用」挑出建議模型。
//
// 建議規則（本工具的分析＝網路搜尋＋撰寫長篇報告，每份約 3–8 分鐘）：
//   - 預設建議最新的 Sonnet：品質接近 Opus，速度較快、單價約為 Opus 的一半；Anthropic 推出新版時自動跟上。
//   - Opus：品質最高，較慢、較貴；Haiku：最快、最便宜，深度較低。
//   - 管理者可用環境變數 RECOMMENDED_MODEL 指定建議模型（須是目錄中的模型）。
//   - Fable／Mythos 等更高階模型單價約為 Opus 的 2.5 倍且回應更久，不列入（避免費用失控）。
// 取不到 Models API 時改用下方的備援清單（FALLBACK），並在 5 分鐘後重試。

const MODELS_URL = 'https://api.anthropic.com/v1/models';
const CACHE_MS = 6 * 60 * 60 * 1000, FAIL_CACHE_MS = 5 * 60 * 1000, FETCH_TIMEOUT_MS = 6000;
const FAMILIES = ['sonnet', 'opus', 'haiku'];   // 顯示順序：建議（Sonnet）在前

// 備援清單：Models API 無法使用時
const FALLBACK = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
];

// 每百萬 tokens 的美元單價（Models API 不提供價格）。未列出的新模型沿用同系列最新一筆的價格，並標示為估計。
const PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
};
const FAMILY_PRICE = { opus: [4, 20], sonnet: [2, 10], haiku: [1, 5] };

// 解析模型 ID：claude-<系列>-<主版>[-<次版>][-<日期>]
export function parseModelId(id) {
  const m = /^claude-(opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(String(id || ''));
  return m ? { family: m[1], major: +m[2], minor: m[3] ? +m[3] : 0, date: m[4] || '' } : null;
}
const newer = (a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.date > b.date ? 1 : a.date < b.date ? -1 : 0);

function priceOf(id) {
  const p = parseModelId(id);
  const base = p ? `claude-${p.family}-${p.major}${p.minor ? '-' + p.minor : ''}` : id;
  if (PRICES[id]) return { in: PRICES[id][0], out: PRICES[id][1], est: false };
  if (PRICES[base]) return { in: PRICES[base][0], out: PRICES[base][1], est: false };
  const f = p && FAMILY_PRICE[p.family];
  return f ? { in: f[0], out: f[1], est: true } : null;
}

// 推理強度（effort）：Opus ≥4.5、Sonnet ≥4.6 支援；Haiku 4.5 不支援（送出會錯誤）
export function supportsEffort(id) {
  const p = parseModelId(id);
  if (!p) return false;
  if (p.family === 'opus') return p.major > 4 || (p.major === 4 && p.minor >= 5);
  if (p.family === 'sonnet') return p.major > 4 || (p.major === 4 && p.minor >= 6);
  return false;
}
// 預設開啟思考（adaptive）的模型：思考 token 計入 max_tokens，需要較大的上限
export function thinksByDefault(id) {
  const p = parseModelId(id);
  return !!p && p.family !== 'haiku' && p.major >= 5;
}

function build(list, source) {
  const best = {};
  for (const m of list) {
    const p = parseModelId(m.id);
    if (!p) continue;
    if (!best[p.family] || newer(p, best[p.family].p) > 0) best[p.family] = { p, m };
  }
  const models = FAMILIES.filter(f => best[f]).map(f => {
    const { m, p } = best[f];
    return { id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id, family: f, price: priceOf(m.id) };
  });
  const envRec = (globalThis.Deno && Deno.env.get('RECOMMENDED_MODEL')) || '';
  const rec = models.find(m => m.id === envRec) || models.find(m => m.family === 'sonnet') || models[0];
  return { models, recommended: rec ? rec.id : '', source, at: new Date().toISOString() };
}

let cache = null, cacheUntil = 0, inflight = null;

async function fetchList(apiKey) {
  const out = [];
  let after = '';
  for (let page = 0; page < 5; page++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(`${MODELS_URL}?limit=100${after ? '&after_id=' + encodeURIComponent(after) : ''}`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, signal: ctl.signal,
      });
    } finally { clearTimeout(t); }
    if (!r.ok) throw new Error('models HTTP ' + r.status);
    const j = await r.json();
    for (const d of (Array.isArray(j.data) ? j.data : [])) {
      if (d && typeof d.id === 'string') out.push({ id: d.id, name: typeof d.display_name === 'string' ? d.display_name.slice(0, 60) : '' });
    }
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return out;
}

// 取得模型目錄（含快取）。apiKey 缺少或 API 失敗時回傳備援清單。
export async function getCatalog(apiKey) {
  const now = Date.now();
  if (cache && now < cacheUntil) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      if (!apiKey) throw new Error('no key');
      const list = await fetchList(apiKey);
      const c = build(list, 'api');
      if (!c.models.length) throw new Error('empty');
      cache = c; cacheUntil = Date.now() + CACHE_MS;
    } catch (_) {
      cache = build(FALLBACK, 'fallback'); cacheUntil = Date.now() + FAIL_CACHE_MS;
    } finally { inflight = null; }
    return cache;
  })();
  return inflight;
}

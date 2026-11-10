// 分析請求的共用設定（analyze.js 的 Edge Function 與 analyze-bg.mjs 的背景 Function 都用這一份）
// 目的：模型工具、token 上限、推理強度、提示快取這些「怎麼呼叫 Anthropic」的決定只寫一次，
// 串流路徑與背景工作路徑送出的請求完全相同，差別只在結果送到哪裡（瀏覽器 vs Netlify Blobs）。

import { supportsEffort, supportsDynamicTools, thinksByDefault } from './model-catalog.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// 提示詞長度上限（防濫用；與 index.html 的 PROMPT_MAX_CHARS 一致）。算的是字元不是 token：英文提示詞的字元數約是
// 中文的 2.7 倍（英文 4 字元≈1 token，中文 1 字≈1 token），英文版帶活動、NDVI 與 iNaturalist／OSM／TBN 三組資料約 38,000 字元，
// 中文版同樣條件約 20,000；舊上限 24,000 會擋掉正常的英文分析（2026-11-10 放寬）
export const MAX_PROMPT_CHARS = 50000;
// 輸出上限：新一代模型預設會先思考（思考 token 也計入），上限給得較寬；只依實際產生量計費
export const MAX_TOKENS = 64000;
// 推理強度：分析用 high（多查、查得仔細，減少「未查得」），改寫只刪除與更正用 low
export const EFFORT = { analyze: 'high', revise: 'low', support: 'medium' };
// 網路工具：搜尋 ≤15 次（與 index.html 的 WEB_SEARCH_MAX 一致）；讀取網頁全文 ≤6 次（論文、政府文件中的數值多半不在搜尋摘要裡）。
// Sonnet／Opus 4.6 以上用可過濾結果的新版工具（先以程式篩出相關段落再放進內容，省 token）；Haiku 只搜尋（維持便宜、快速）。
export const WEB_SEARCH_MAX = 15, WEB_FETCH_MAX = 6, FETCH_MAX_CONTENT_TOKENS = 15000;
// 提示快取（2026-11-05 開）：只開在會上網的分析。請求裡只要有一個 cache_control，API 就會在每一次搜尋／讀網頁的結果後面
// 自動設快取點，下一輪重讀前面的內容改按快取價。詳見 analyze.js 檔頭。
export const PROMPT_CACHE = { type: 'ephemeral' };

export function webTools(model) {
  if (supportsDynamicTools(model)) {
    return [
      { type: 'web_search_20260209', name: 'web_search', max_uses: WEB_SEARCH_MAX },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: WEB_FETCH_MAX, max_content_tokens: FETCH_MAX_CONTENT_TOKENS, citations: { enabled: true } },
    ];
  }
  return [{ type: 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX }];
}

// 分析（mode 'analyze'）的輸出上限
export function analyzeMaxTokens(model) {
  return /haiku/.test(model) ? 32000 : MAX_TOKENS;
}

// 分析的 user 訊息：提示詞本身標一個快取點，確定「請求裡有 cache_control」，搜尋迴圈才會自動設快取點
export function analyzeUserMessages(prompt, cache = true) {
  return [{ role: 'user', content: cache ? [{ type: 'text', text: prompt, cache_control: PROMPT_CACHE }] : prompt }];
}

// 分析的請求本體（串流）。messages 由呼叫端給（第一次是 user 訊息；pause_turn／接力續跑時再接 assistant 內容）
export function analyzeRequestBody(model, messages, cache = true) {
  return {
    model,
    max_tokens: analyzeMaxTokens(model),
    stream: true,
    ...(supportsEffort(model) ? { output_config: { effort: EFFORT.analyze } } : {}),
    // 頂層的 cache_control＝自動快取：快取點放在最後一個可快取的區塊。接續時那是前一輪最後的內容，
    // 接續請求因此讀得到前一輪寫進快取的搜尋結果，不必整段重算
    ...(cache ? { cache_control: PROMPT_CACHE } : {}),
    messages,
    tools: webTools(model),
  };
}

export function anthropicHeaders(apiKey) {
  return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

export { thinksByDefault };

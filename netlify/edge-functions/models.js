// 可用模型與建議模型（GET /api/models）
// 回傳各系列最新一版的模型、每百萬 tokens 單價與建議模型；清單由 Anthropic Models API 取得（快取 6 小時），
// 前端據此產生「分析模型」選單，不必在程式裡寫死模型名稱。不需通行碼：只公開模型名稱與公開價格。
import { getCatalog } from '../shared/model-catalog.js';

export default async (request) => {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const c = await getCatalog(Deno.env.get('ANTHROPIC_API_KEY'));
  return new Response(JSON.stringify(c), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' },
  });
};

export const config = { path: '/api/models' };

// SSE 轉送（analyze.js 使用）
// 1) 伺服器端搜尋迴圈暫停（stop_reason: pause_turn）時自動接續：把目前為止的 assistant 內容送回 API，
//    讓模型從暫停處繼續（不另加 user 訊息），瀏覽器看到的是一段連續的串流。
// 2) 長時間沒有資料（模型思考、讀取網頁）時送出 SSE 註解行（keepalive），避免瀏覽器判定連線卡住。
// 3) 讀取網頁（web_fetch）的全文只留給接續請求使用，轉送給瀏覽器時刪除（手機不必下載整份 PDF）。
// 4) token 用量：接續多次時，轉送的 message_delta 改為累計值。

const KEEPALIVE_MS = 15000;

// 從 SSE 事件組回 assistant 的內容區塊（供接續請求使用）
export function makeAssembler() {
  const blocks = [];
  let cur = [];   // 本次請求的區塊（index 從 0 起算）
  return {
    onEvent(ev) {
      if (ev.type === 'message_start') { cur = []; return; }
      if (ev.type === 'content_block_start' && ev.content_block) {
        const b = JSON.parse(JSON.stringify(ev.content_block));
        if ((b.type === 'server_tool_use' || b.type === 'tool_use') ) b._json = '';
        cur[ev.index] = b;
        return;
      }
      const b = cur[ev.index];
      if (!b) return;
      if (ev.type === 'content_block_delta' && ev.delta) {
        const d = ev.delta;
        if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
        else if (d.type === 'input_json_delta') b._json = (b._json || '') + (d.partial_json || '');
        else if (d.type === 'citations_delta' && d.citation) (b.citations = b.citations || []).push(d.citation);
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
        else if (d.type === 'signature_delta') b.signature = d.signature;
      } else if (ev.type === 'content_block_stop') {
        if (b._json !== undefined) {
          if (b._json) { try { b.input = JSON.parse(b._json); } catch (_) { /* 輸入不完整：保留原本的 input */ } }
          delete b._json;
        }
        blocks.push(b);
        cur[ev.index] = null;
      }
    },
    // API 不接受空白的文字區塊
    content() { return blocks.filter(b => !(b.type === 'text' && !(b.text || '').length && !(b.citations || []).length)); },
  };
}

// 轉送給瀏覽器時刪除讀取網頁的全文（只留網址與標題）
export function slimEvent(ev) {
  const cb = ev && ev.type === 'content_block_start' && ev.content_block;
  if (!cb || cb.type !== 'web_fetch_tool_result' || !cb.content || cb.content.type !== 'web_fetch_result') return ev;
  const c = cb.content, doc = c.content || {};
  return { ...ev, content_block: { ...cb, content: { type: 'web_fetch_result', url: c.url, retrieved_at: c.retrieved_at,
    content: { type: 'document', title: typeof doc.title === 'string' ? doc.title : undefined } } } };
}

const addUsage = (a, u) => {
  if (!u) return a;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) if (typeof u[k] === 'number') a[k] = (a[k] || 0) + u[k];
  if (u.server_tool_use) {
    a.server_tool_use = a.server_tool_use || {};
    for (const [k, v] of Object.entries(u.server_tool_use)) if (typeof v === 'number') a.server_tool_use[k] = (a.server_tool_use[k] || 0) + v;
  }
  return a;
};

// first：第一個上游回應（已確認 ok）；next(messages)：送出接續請求，回傳 Response
export function relay(first, { userMessages, next, maxContinuations = 4, keepaliveMs = KEEPALIVE_MS }) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  let closed = false;
  const write = s => closed ? Promise.resolve() : writer.write(enc.encode(s)).catch(() => { closed = true; });
  const sendEvent = ev => write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  let lastWrite = Date.now();
  const ka = setInterval(() => { if (Date.now() - lastWrite >= keepaliveMs) { lastWrite = Date.now(); write(': keepalive\n\n'); } }, Math.min(keepaliveMs, 5000));

  (async () => {
    const asm = makeAssembler();
    const total = {};
    let res = first, round = 0;
    try {
      while (true) {
        let cur = {}, held = [], pause = false;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const handle = async raw => {
          const line = raw.split('\n').find(l => l.startsWith('data:'));
          if (!line) return;
          let ev;
          try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { return; }
          asm.onEvent(ev);
          if (ev.type === 'message_start') {
            cur = addUsage({}, ev.message && ev.message.usage);
            if (round > 0) return;   // 接續請求的 message_start 不轉送（瀏覽器看到的是同一則訊息）
          }
          if (ev.type === 'message_delta') {
            // message_delta 的 usage 是本次請求的累計值：以它取代本次的數字，再加上先前各次
            if (ev.usage) for (const k of Object.keys(ev.usage)) cur[k] = ev.usage[k];
            const sum = addUsage(addUsage({}, total), cur);
            const out = { ...ev, usage: sum };
            if (ev.delta && ev.delta.stop_reason === 'pause_turn' && round < maxContinuations) { pause = true; held.push(out); return; }
            await sendEvent(out); lastWrite = Date.now(); return;
          }
          if (ev.type === 'message_stop' && pause) { held.push(ev); return; }
          await sendEvent(slimEvent(ev)); lastWrite = Date.now();
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); await handle(raw); }
          if (closed) { try { await reader.cancel(); } catch (_) {} return; }
        }
        if (buf.trim()) await handle(buf);
        if (!pause) return;
        // 接續：送回目前為止的 assistant 內容（不加 user 訊息），模型從暫停處繼續
        addUsage(total, cur);
        round++;
        let r2;
        try { r2 = await next([...userMessages, { role: 'assistant', content: asm.content() }]); } catch (_) { r2 = null; }
        if (!r2 || !r2.ok || !r2.body) {
          // 接續失敗：照原樣結束（pause_turn → 前端標示報告可能不完整）
          for (const ev of held) await sendEvent(ev);
          return;
        }
        res = r2;
      }
    } catch (e) {
      await sendEvent({ type: 'error', error: { type: 'relay_error', message: '串流轉送中斷：' + (e && e.message || String(e)) } });
    } finally {
      clearInterval(ka);
      closed || (await writer.close().catch(() => {}));
      closed = true;
    }
  })();
  return readable;
}

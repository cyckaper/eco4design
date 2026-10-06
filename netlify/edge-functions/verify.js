// 棲共生 · 參考文獻真實性查核（Netlify Edge Function / Deno）
// 目的：報告產出後，逐筆確認參考文獻「真的存在」且「DOI／網址確實指向所引用的著作」。
// 學術嚴謹度的底線：捏造的文獻絕不可判為「已查證」；無法確定時寧可判「需人工查證」。
//
// 查核來源（皆為公開學術基礎設施，不需金鑰）：
//   1. doi.org Handle API：DOI 是否已註冊（responseCode 1 = 存在、100 = 不存在）
//   2. Crossref REST API（/works/{doi}）：DOI 的登記題名、年份、作者
//   3. doi.org 內容協商（CSL-JSON）：非 Crossref 的 DOI（DataCite、Airiti、JaLC 等）
//      註冊機構不支援內容協商時，doi.org 會導向落地頁面，改讀頁面的 citation_title
//   4. OpenAlex（/works/doi:…）：Crossref 被限流或失敗時的備援
//   5. 直接開啟引用的網址：讀 <title>、citation_title、dc.title、og:title，或在內文找引用題名；PDF 讀中繼資料
//   6. Crossref（query.bibliographic）＋ OpenAlex（search）書目搜尋：
//      沒有 DOI／網址的書籍與報告，或 DOI 指錯著作時，找出實際存在的版本
//   7. 網際網路檔案館 Wayback availability API（archive.org/wayback/available）：
//      網址失效時確認「是否曾經存在」（政府機關改組後舊網址大量失效；捏造的路徑幾乎不會被存檔）
//
// 請求（POST JSON）：{ passcode, lang: 'zh'|'en', refs: [{ id, text, urls[], dois[] }] }（最多 25 筆）
// 回應：application/x-ndjson 串流；每查完一筆送出一行，最後一行 {"done":true,"stats":{…}}。
// 判定（verdict）：
//   verified     已查證：DOI／網址可解析且題名相符（相似度 ≥ 0.6、年份 ±1），或書目搜尋強相符（≥ 0.85、年份 ±1、作者不衝突）
//   partial      部分查證：來源存在，但內容無法自動比對（PDF 無中繼資料、動態網頁、題名 0.35–0.6、年份或作者不符）
//   mismatch     不相符：DOI／學術中繼資料指向另一篇著作（題名相似度 < 0.35）——常見的 AI「真 DOI、錯論文」
//   not_found    查無：DOI 未註冊、網址 404／410／網域不存在，且書目搜尋也找不到相近著作——疑為捏造或連結失效
//   unverifiable 無法查證：沒有 DOI／網址且搜尋不到（常見於紙本書、政府出版品）——需人工查證
//   inconclusive 未能判定：逾時、403、429 等網路問題
//
// 環境變數：QI_PASSCODE（必填，與 analyze 共用；未設定時本端點回 503，不開放）、
//   VERIFY_MAILTO（建議設定，Crossref／OpenAlex 禮貌池聯絡信箱，只會送給這兩個服務）、
//   VERIFY_OPENALEX_KEY（選填，OpenAlex API 金鑰）、
//   VERIFY_UPSTREAM_TIMEOUT_MS／VERIFY_TOTAL_TIMEOUT_MS／VERIFY_CPU_BUDGET_MS（選填，調校與測試用）

const MAX_REFS = 25;                  // 每次最多查核筆數（超過回 413）
const MAX_URLS_PER_REF = 3;
const MAX_DOIS_PER_REF = 2;
const MAX_TEXT_CHARS = 600;           // 每筆文獻文字上限（超過截斷）
const HARD_TEXT_CHARS = 4000;         // 明顯異常的長度直接拒絕
const MAX_LIST_ITEMS = 20;            // urls／dois 陣列的硬上限（超過視為格式錯誤）
const MAX_URL_CHARS = 2048;
const MAX_BODY_BYTES = 256 * 1024;    // 請求內容上限
const MAX_PAGE_BYTES = 400 * 1024;    // 網頁／PDF 最多讀 400 KB
const MAX_API_BYTES = 2 * 1024 * 1024; // API 回應上限（Crossref 單筆含引用清單時可能較大）
const MAX_ERROR_BYTES = 64 * 1024;    // 錯誤回應只讀一小段
const MAX_REDIRECTS = 8;              // 手動追蹤轉址，每一跳都重新檢查安全性
const MAX_FOUND_TITLE = 300;
const REF_CONCURRENCY = 5;            // 同時查核筆數
const MAX_HOST_FETCHES = 24;          // 同一次請求對同一網站（非書目 API）最多連線次數（含轉址）；依筆數放寬：max(24, min(48, 12 + 3 × 筆數))
const MAX_DOI_CHARS = 300;            // 單一 DOI 字串上限（DOI 本身不超過 200 字元；更長的一律捨棄，不進入任何解析）
const UPSTREAM_BASE = 40, UPSTREAM_PER_REF = 14, UPSTREAM_MAX = 300;   // 同一次請求的對外連線總數上限：min(300, 40 + 14 × 筆數)
const RATE_WINDOW_MS = 5 * 60 * 1000, RATE_MAX = 100;                // 同一來源 IP 每 5 分鐘最多 100 次請求（單一執行個體內）
const CPU_BUDGET_MS = 40;             // 頁面解析的運算時間預算（Netlify Edge 每次請求 CPU 上限 50 ms；等待網路不計）
const UPSTREAM_TIMEOUT_MS = 12000;    // 每個上游請求（部分政府網站回應較慢）
const TOTAL_TIMEOUT_MS = 35000;       // 整體上限（headers 立即回傳，結果逐行串流）

const UA = 'Qi-Coexistence-RefCheck/1.0 (+https://eco4design.healsdesign.org)';

// ── 判定門檻（全部寫死，結果可重現）──
const SCORE_MATCH = 0.6;              // 題名相符
const SCORE_MISMATCH = 0.35;          // 低於此 → 指向另一篇著作
const SCORE_SEARCH_STRONG = 0.85;     // 書目搜尋強相符
const SCORE_SEARCH_NOYEAR = 0.92;     // 任一方沒有年份時，搜尋需更高相似度
const YEAR_TOLERANCE = 1;             // 線上版／紙本版常差一年
// 政府網頁、中文文獻多不在 Crossref／OpenAlex 中：連結失效（404、410、導回首頁、錯誤頁）＋無存檔＋搜尋落空時，
// 無法區分「連結失效」與「文獻不存在」。false＝維持「查無此文獻」但說明不能排除連結失效；true＝改判「無法查證」
const DEAD_LINK_AS_UNVERIFIABLE = false;

const VERDICTS = ['verified', 'partial', 'mismatch', 'not_found', 'unverifiable', 'inconclusive'];

// ── 雙語訊息（繁體中文用台灣用語）──
const MSG = {
  // 請求錯誤
  bad_method: ['只接受 POST', 'Method not allowed'],
  body_too_large: ['請求內容過大', 'Request body too large'],
  bad_json: ['請求格式錯誤（非合法 JSON）', 'Malformed request (invalid JSON)'],
  bad_body: ['請求格式錯誤（應為 JSON 物件）', 'Malformed request (expected a JSON object)'],
  bad_ctype: ['請求格式錯誤（Content-Type 應為 application/json）', 'Malformed request (Content-Type must be application/json)'],
  not_configured: ['文獻查證服務尚未設定通行碼（QI_PASSCODE），暫不開放', 'The reference-verification service has no passcode configured (QI_PASSCODE), so it is disabled'],
  rate_limited_req: ['查證請求過於頻繁，請稍後再試', 'Too many verification requests; please try again shortly'],
  passcode_required: ['需要通行碼', 'Passcode required'],
  passcode_invalid: ['通行碼不正確', 'Incorrect passcode'],
  no_refs: ['沒有要查核的參考文獻（refs 應為非空陣列）', 'No references to check (refs must be a non-empty array)'],
  too_many_refs: ['參考文獻過多（{n} 筆，上限 {max} 筆）', 'Too many references ({n}; the limit is {max})'],
  bad_ref: ['第 {i} 筆參考文獻格式錯誤：{why}', 'Reference #{i} is malformed: {why}'],

  // DOI 檢核
  doi_match: ['DOI 已註冊，{src} 書目資料的題名與引用相符', 'DOI is registered; the {src} record’s title matches the citation'],
  doi_grey: ['DOI 已註冊，但登記題名與引用僅部分相似', 'DOI is registered, but its title only partly resembles the citation'],
  doi_wrong_work: ['DOI 已註冊，但指向另一篇著作', 'DOI is registered but points to a different work'],
  doi_title_unsure: ['DOI 已註冊，但無法從引用文字辨識題名，未能比對', 'DOI is registered, but the cited title could not be identified for comparison'],
  doi_cross_lang: ['DOI 已註冊，但登記題名與引用題名語言不同，無法自動比對', 'DOI is registered, but its title is in a different language from the citation and cannot be compared automatically'],
  doi_year: ['DOI 已註冊且題名相符，但出版年不同（引用 {cy}，登記 {fy}）', 'DOI is registered and the title matches, but the year differs (cited {cy}, registered {fy})'],
  doi_author: ['DOI 已註冊且題名相符，但作者與登記資料不符', 'DOI is registered and the title matches, but the authors differ from the record'],
  doi_no_metadata: ['DOI 已註冊，但查無可比對的書目資料', 'DOI is registered, but no metadata was available to compare'],
  doi_not_registered: ['DOI 未註冊（doi.org 查無此號）', 'DOI is not registered (unknown to doi.org)'],
  doi_landing_match: ['DOI 已註冊；導向頁面的題名與引用相符', 'DOI is registered; the landing page title matches the citation'],
  doi_landing_unmatched: ['DOI 已註冊，但導向頁面未見引用題名', 'DOI is registered, but the cited title was not found on its landing page'],

  // 題名關鍵詞／卷期（P1、P10）
  doi_terms: ['DOI 已註冊，題名大致相似但關鍵詞不同（引用「{c}」／登記「{f}」）', 'DOI is registered and the title is similar, but key terms differ (cited “{c}” / registered “{f}”)'],
  doi_notice: ['DOI 指向更正／撤稿等聲明（「{ft}」），而不是原著作', 'The DOI points to a notice (“{ft}”), not to the work itself'],
  doi_biblio: ['DOI 已註冊且題名相符，但卷期與頁碼都與登記資料不符', 'DOI is registered and the title matches, but neither volume nor pages match the record'],
  doi_cross_lang_mis: ['DOI 已註冊，但登記資料為另一種語言，且年份或卷期頁碼也不符，應為另一篇著作', 'DOI is registered, but its record is in another language and the year or volume/pages also differ: it is a different work'],
  url_terms: ['頁面題名大致相似但關鍵詞不同（引用「{c}」／頁面「{f}」）', 'The page title is similar, but key terms differ (cited “{c}” / page “{f}”)'],
  waf: ['網站防火牆攔截自動存取', 'The site’s firewall blocked automated access'],
  home_only: ['網址是網站首頁，無法指認文獻本身', 'The URL is a site home page and does not identify the document'],
  archived_match: ['網際網路檔案館 {d} 的存檔與引用相符', 'the Internet Archive copy from {d} matches the citation'],
  archived_nomatch: ['網際網路檔案館有 {d} 的存檔，但未能確認內容', 'the Internet Archive has a copy from {d}, but its content could not be confirmed'],
  isbn_invalid: ['ISBN 檢查碼錯誤（{isbn}），此 ISBN 不可能存在', 'Invalid ISBN check digit ({isbn}); no book can carry this ISBN'],

  // 網址檢核
  url_meta_match: ['網頁可開啟，頁面題名與引用相符', 'Page opens and its title matches the citation'],
  url_in_page: ['網頁可開啟，頁面內文含有引用題名', 'Page opens and its text contains the cited title'],
  url_grey: ['網頁可開啟，但頁面題名與引用僅部分相似', 'Page opens, but its title only partly resembles the citation'],
  url_not_in_page: ['網頁可開啟，但頁面未見引用題名（可能為首頁、搜尋頁或題名不同）', 'Page opens, but the cited title was not found on it (it may be a home page, a search page, or titled differently)'],
  url_js_only: ['網頁可開啟，但內容由程式動態載入，無法自動比對', 'Page opens, but its content is rendered by JavaScript and cannot be matched automatically'],
  url_wrong_work: ['網頁的學術詮釋資料指向另一篇著作', 'The page’s scholarly metadata describes a different work'],
  url_year: ['頁面題名相符，但出版年不同（引用 {cy}，頁面 {fy}）', 'Page title matches, but the year differs (cited {cy}, page {fy})'],
  url_author: ['頁面題名相符，但作者與頁面資料不符', 'Page title matches, but the authors differ from the page metadata'],
  pdf_match: ['PDF 可開啟，檔案詮釋資料題名與引用相符', 'PDF opens and its embedded title matches the citation'],
  pdf_nometa: ['PDF 可開啟，但沒有可比對的題名資料', 'PDF opens, but has no usable title metadata'],
  pdf_title_differs: ['PDF 可開啟，但檔案詮釋資料題名與引用不同（詮釋資料常不可靠）', 'PDF opens, but its embedded title differs (embedded metadata is often unreliable)'],
  filetype: ['檔案可開啟（{type}），無法自動比對內容', 'File opens ({type}) but its content cannot be matched automatically'],
  http_404: ['網址不存在（HTTP 404）', 'URL does not exist (HTTP 404)'],
  http_410: ['網址已移除（HTTP 410）', 'URL has been removed (HTTP 410)'],
  soft_404: ['網頁顯示「找不到頁面」', 'The page reports “not found”'],
  redirect_home: ['網址被導回網站首頁，原頁面可能已不存在', 'The URL redirects to the site’s home page; the original page may no longer exist'],
  home_mentions: ['網站首頁提到引用題名，但首頁不是文獻本身，請改引用該文獻的頁面', 'The home page mentions the cited title, but it is not the document itself; cite the document’s own page'],
  moved_home_mentions: ['網址被導回網站首頁，首頁提到引用題名，但原連結已失效', 'The URL redirects to the home page, which mentions the cited title, but the original link is dead'],
  dns_error: ['網域無法解析（查無此網域）', 'Domain does not resolve (no such domain)'],
  dns_check_failed: ['無法確認網域的位址（DNS 查詢逾時或失敗），基於安全未連線', 'The domain’s address could not be confirmed (DNS lookup timed out or failed), so it was not fetched for safety'],
  unsafe_url: ['網址指向內部、保留或不允許的位址，未連線檢查', 'URL points to an internal, reserved or disallowed address; not fetched'],
  invalid_url: ['網址格式無效', 'Malformed URL'],
  unsafe_redirect: ['網址轉向內部或不允許的位址，已停止追蹤', 'URL redirects to an internal or disallowed address; stopped'],
  too_many_redirects: ['轉址次數過多', 'Too many redirects'],
  bad_redirect: ['轉址資訊無效', 'Invalid redirect'],
  blocked_403: ['網站拒絕自動存取（HTTP {code}）', 'The site refused automated access (HTTP {code})'],
  rate_limited: ['查詢過於頻繁，被暫時限制（HTTP 429）', 'Rate-limited (HTTP 429)'],
  http_error: ['伺服器回應錯誤（HTTP {code}）', 'Server responded with an error (HTTP {code})'],
  timeout: ['連線逾時', 'Connection timed out'],
  upstream_budget: ['本次查核的對外連線數已達上限，未檢查（可分批重新查核）', 'This run’s limit on outgoing requests was reached, so it was not checked (re-check in smaller batches)'],
  host_budget: ['本次查核對同一網站的連線數已達上限，未檢查（可分批重新查核）', 'This run’s limit on requests to the same site was reached, so it was not checked (re-check in smaller batches)'],
  deadline: ['已達本次查核的時間上限，未完成', 'Stopped at this run’s time limit'],
  cpu_budget: ['網頁可開啟，但本次查核的運算量已達上限，未比對內容（可分批重新查核）', 'The page opens, but this run’s processing budget was used up before its content could be compared (re-check in smaller batches)'],
  tls_error: ['安全連線（TLS）失敗', 'Secure connection (TLS) failed'],
  connect_error: ['無法連線至伺服器', 'Could not connect to the server'],
  network_error: ['網路連線失敗', 'Network error'],
  bad_metadata: ['書目服務回應格式異常', 'Unexpected response from the bibliographic service'],
  record_mismatch: ['書目服務回傳的 DOI 與引用的 DOI 不同，未採用', 'The bibliographic service returned a record for a different DOI; it was not used'],
  internal_error: ['查核程式發生錯誤', 'Internal error while checking'],

  // 書目搜尋
  search_match: ['{src} 查得相符著作', '{src} returned a matching work'],
  search_similar: ['{src} 查得相近著作，但無法確認為同一筆', '{src} returned a similar work that could not be confirmed as the same one'],
  search_similar_author: ['{src} 有題名相符的著作，但作者不同', '{src} lists a work with this title but different authors'],
  search_similar_year: ['{src} 有題名相符的著作，但出版年不同', '{src} lists a work with this title but a different year'],
  search_similar_terms: ['{src} 有題名相近的著作，但關鍵詞不同', '{src} lists a similar title with different key terms'],
  search_similar_generic: ['{src} 有同名著作，但題名過於一般，且無法確認作者為同一人', '{src} lists a work with this title, but the title is too generic and the authors could not be confirmed'],
  search_none: ['Crossref 與 OpenAlex 均查無相近著作', 'Neither Crossref nor OpenAlex returned a similar work'],
  search_none_half: ['{ok} 查無相近著作（{bad} 無法連線）', '{ok} returned no similar work ({bad} could not be reached)'],
  search_error: ['書目搜尋無法完成（{why}）', 'Bibliographic search could not be completed ({why})'],

  // 每筆結論
  S_ver_doi: ['DOI 可解析，{src} 書目資料的題名與引用相符（題名相似度 {s}）。', 'The DOI resolves and the title in its {src} record matches the citation (title similarity {s}).'],
  S_ver_doi_landing: ['DOI 可解析，導向頁面的題名與引用相符。', 'The DOI resolves and its landing page title matches the citation.'],
  S_ver_url_meta: ['網址可開啟，頁面題名與引用相符（題名相似度 {s}）。', 'The URL opens and the page title matches the citation (title similarity {s}).'],
  S_ver_url_text: ['網址可開啟，頁面內文含有引用題名。', 'The URL opens and the page text contains the cited title.'],
  S_ver_url_pdf: ['網址可開啟（PDF），檔案詮釋資料題名與引用相符。', 'The URL opens (PDF) and its embedded title matches the citation.'],
  S_ver_search: ['{pre}{src} 查得相符著作（題名相似度 {s}{yr}）。', '{pre}{src} lists a matching work (title similarity {s}{yr}).'],
  S_pre_noid: ['未附 DOI 或網址；', 'No DOI or URL was given; '],
  S_pre_err: ['引用的 DOI／網址無法連線檢查；', 'The cited DOI/URL could not be checked; '],
  S_mis_doi: ['DOI 已註冊，但指向另一篇著作，與引用題名不符（常見的「真 DOI、錯文獻」）。', 'The DOI is registered but points to a different work, not the cited title (a common “real DOI, wrong work” error).'],
  S_mis_doi_xlang: ['DOI 已註冊，但登記資料為另一種語言，且年份或卷期頁碼也不符：指向另一篇著作。', 'The DOI is registered, but its record is in another language and the year or volume/pages also differ: it points to a different work.'],
  S_mis_url: ['網址的學術詮釋資料指向另一篇著作，與引用題名不符。', 'The page’s scholarly metadata describes a different work, not the cited title.'],
  S_part_url_mixed: ['其中一個網址內容相符，但另一個網址指向另一篇著作「{ft}」，請移除錯誤的網址。', 'One URL matches the citation, but another points to a different work (“{ft}”); remove the wrong URL.'],
  S_add_dead: ['另：引用中的其他網址無效（{why}）。', ' Note: another cited URL is invalid ({why}).'],
  S_part_doi_mixed: ['其中一個 DOI 與引用相符，但另一個 DOI 指向另一篇著作「{ft}」，請移除錯誤的 DOI。', 'One DOI matches the citation, but another DOI points to a different work (“{ft}”); remove the wrong DOI.'],
  S_mis_doi_url_ok: ['網址內容與引用相符，但 DOI 指向另一篇著作，DOI 需更正。', 'The URL matches the citation, but the DOI points to a different work; the DOI must be corrected.'],
  S_part_doi_bad_src_ok: ['來源可開啟且題名相符，但引用的 DOI 未註冊，DOI 需更正。', 'The source opens and its title matches, but the cited DOI is not registered and must be corrected.'],
  S_part_exists_bad_id: ['{src} 查得此著作，但引用中的識別資訊有誤（{why}），請改用建議的 DOI／連結。', '{src} lists this work, but the cited identifier is wrong ({why}); use the suggested DOI/link instead.'],
  neg_doi_not_registered: ['DOI 未註冊', 'DOI not registered'],
  neg_http_404: ['網址 HTTP 404', 'URL returns HTTP 404'],
  neg_http_410: ['網址 HTTP 410', 'URL returns HTTP 410'],
  neg_dns_error: ['網域不存在', 'domain does not exist'],
  neg_unsafe_url: ['網址不是公開位址', 'URL is not a public address'],
  neg_invalid_url: ['網址格式無效', 'malformed URL'],
  neg_soft_404: ['頁面顯示找不到', 'page reports not found'],
  neg_redirect_home: ['網址被導回首頁', 'URL redirects to the home page'],
  S_part_terms: ['來源存在，但題名的關鍵詞與來源不同（引用「{c}」／來源「{f}」）：可能引錯文獻或題名被改寫，請人工確認。', 'The source exists, but key terms in the title differ (cited “{c}” / source “{f}”): the reference may be misattributed or its title altered; check manually.'],
  S_part_notice: ['DOI 指向更正、勘誤或撤稿聲明（「{ft}」），而不是原著作：請改用原文的 DOI，並確認原文是否已被撤稿。', 'The DOI points to a correction, erratum or retraction notice (“{ft}”) rather than the work itself: cite the original article’s DOI and check whether it has been retracted.'],
  S_part_biblio: ['題名相符，但卷期與頁碼都與登記資料不符（登記：第 {vol} 卷，第 {pg} 頁起），請確認期刊、卷期與頁碼。', 'The title matches, but neither the volume nor the pages match the record (record: vol. {vol}, p. {pg}); check the journal, volume and pages.'],
  S_part_archived: ['原網址已失效（{why}），但網際網路檔案館 {d} 的存檔與引用相符：文獻存在，請更新網址。', 'The link is dead ({why}), but the Internet Archive copy from {d} matches the citation: the document exists; update the URL.'],
  S_unv_archived: ['原網址已失效（{why}），但網際網路檔案館曾於 {d} 存檔此網址（網址曾經存在）；存檔內容未能確認與引用相符，請人工確認並更新網址。', 'The link is dead ({why}), but the Internet Archive captured this URL on {d} (the URL did exist); the archived content could not be confirmed to match the citation; verify manually and update the URL.'],
  S_unv_home: ['網址只是網站首頁（無法指認文獻本身），且 {srch}，需人工查證；請改引用文獻本身的網址。', 'The URL is only a site home page (it does not identify the document), and {srch}; verify manually and cite the document’s own URL.'],
  S_unv_similar_terms: ['{pre}書目資料庫有題名相近的著作，但關鍵詞不同（引用「{c}」／資料庫「{f}」）：可能是改寫自另一篇文獻，請人工比對建議項目。', '{pre}the bibliographic databases list a similar title with different key terms (cited “{c}” / database “{f}”): it may be an altered version of another work; compare the suggestion manually.'],
  S_unv_similar_generic: ['{pre}書目資料庫有同名著作，但題名過於一般、作者無法確認，不能據以查證，需人工查證。', '{pre}the bibliographic databases list a work with this title, but the title is too generic and the authors could not be confirmed; verify manually.'],
  neg_isbn_invalid: ['ISBN 檢查碼錯誤', 'invalid ISBN check digit'],
  S_nf_generic: ['{neg}；書目資料庫只有題名過於一般的同名著作（{ft}），不足以證實此文獻：可能是不存在的文獻，請人工確認。', '{neg}; the databases only list works with the same generic title ({ft}), which does not confirm this reference: it may not exist; check manually.'],
  S_part_year: ['題名相符，但出版年不同（引用 {cy}，來源 {fy}），請確認年份。', 'The title matches, but the year differs (cited {cy}, source {fy}); check the year.'],
  S_part_author: ['題名相符，但作者與來源資料不符（來源：{fa}），請確認作者。', 'The title matches, but the authors differ from the source record (source: {fa}); check the authors.'],
  S_part_grey: ['來源存在，但題名僅部分相似（題名相似度 {s}），請人工確認是否為同一著作。', 'The source exists, but its title only partly resembles the citation (title similarity {s}); check manually that it is the same work.'],
  S_part_title_unsure: ['來源存在，但無法從引用文字辨識題名以自動比對，請人工確認。', 'The source exists, but the cited title could not be identified for automatic comparison; check manually.'],
  S_part_cross_lang: ['來源存在，但登記題名與引用題名語言不同，無法自動比對，請人工確認。', 'The source exists, but its registered title is in a different language from the citation; check manually.'],
  S_part_pdf: ['PDF 可開啟，但無法以詮釋資料比對題名，請人工確認內容。', 'The PDF opens, but its title could not be matched from metadata; check its content manually.'],
  S_part_js_only: ['網頁可開啟，但內容由程式動態載入，無法自動比對，請人工確認。', 'The page opens, but its content is rendered by JavaScript and cannot be matched automatically; check manually.'],
  S_part_not_in_page: ['網頁可開啟，但頁面中未見引用題名，請人工確認是否為正確頁面。', 'The page opens, but the cited title does not appear on it; check manually that it is the right page.'],
  S_part_no_metadata: ['DOI 已註冊，但查無可比對的書目資料，請人工確認。', 'The DOI is registered, but no metadata was available to compare; check manually.'],
  S_part_home_mentions: ['網址是網站首頁，首頁雖提到引用題名，但無法確認為該文獻，請改引用文獻本身的網址。', 'The URL is a home page that mentions the cited title, but it is not the document itself; cite the document’s own URL.'],
  S_part_moved: ['網址被導回網站首頁；首頁雖提到引用題名，但原連結已失效，請更新為正確網址。', 'The URL redirects to the site’s home page; the home page mentions the cited title, but the original link is dead. Update the URL.'],
  S_part_filetype: ['檔案可開啟，但無法自動比對內容，請人工確認。', 'The file opens, but its content cannot be matched automatically; check manually.'],
  S_add_doi_bad: ['另：引用的 DOI 未註冊。', ' Also, the cited DOI is not registered.'],
  S_nf: ['{neg}，且 {srch}：可能是不存在的文獻，或連結已失效，請人工確認。', '{neg}, and {srch}: the reference may not exist, or its link is dead; check manually.'],
  srch_none: ['Crossref 與 OpenAlex 均查無相近著作', 'neither Crossref nor OpenAlex returned a similar work'],
  srch_none_half: ['{ok} 查無相近著作（{bad} 無法連線，未能查詢）', '{ok} returned no similar work ({bad} could not be reached)'],
  S_nf_nosearch: ['DOI 未註冊，且書目搜尋無法完成：此 DOI 不存在，請人工查證此文獻。', 'The DOI is not registered and the bibliographic search could not be completed: this DOI does not exist; verify the reference manually.'],
  S_unv_none: ['沒有 DOI 或網址可檢核，且 {srch}，需人工查證（常見於紙本書、政府出版品）。', 'No DOI or URL to check, and {srch}; verify manually (common for printed books and government publications).'],
  S_unv_similar: ['{pre}書目資料庫找到相近但無法確認的著作（題名相似度 {s}），請人工比對建議項目。', '{pre}the bibliographic databases returned a similar but unconfirmed work (title similarity {s}); compare the suggestion manually.'],
  S_unv_similar_author: ['{pre}書目資料庫有題名相符的著作，但作者不同（資料庫：{fa}），可能是作者誤植，請人工比對建議項目。', '{pre}the bibliographic databases list a work with this title but different authors ({fa}); the authors may be misattributed. Compare the suggestion manually.'],
  S_unv_similar_year: ['{pre}書目資料庫有題名相符的著作，但出版年不同（資料庫：{fy}），請人工比對建議項目。', '{pre}the bibliographic databases list a work with this title but a different year ({fy}); compare the suggestion manually.'],
  S_unv_pre_noid: ['沒有 DOI 或網址；', 'No DOI or URL; '],
  S_unv_pre_neg: ['{neg}；', '{neg}; '],
  S_unv_nothing: ['沒有可檢核的資訊，需人工查證。', 'Nothing could be checked automatically; verify manually.'],
  // 參考案例（kind: 'case'）：以案例名稱比對所列網頁，不做書目搜尋
  S_case_nourl: ['案例沒有可查核的網址，無法確認來源。', 'The case lists no URL that could be checked, so its source cannot be confirmed.'],
  S_case_dead: ['{neg}，也沒有內容相符的網際網路檔案館存檔：無法確認案例來源存在。', '{neg}, and no matching Internet Archive copy was found: the case source cannot be confirmed.'],
  S_case_weak: ['{why}：所列網頁無法確認是這個案例的來源。', '{why}: the listed page cannot be confirmed as a source for this case.'],
  S_inconc: ['{why}，無法判定，請稍後重試或人工查證。', '{why}; no verdict could be reached. Retry later or verify manually.'],
  S_inconc_neg_search: ['{neg}，但書目搜尋無法完成，無法判定，請稍後重試或人工查證。', '{neg}, but the bibliographic search could not be completed; retry later or verify manually.'],
  S_deadline: ['已達本次查核的時間上限，這筆尚未查核，請重新查核。', 'This run’s time limit was reached before this reference was checked; run the check again.'],
  S_internal: ['查核程式發生錯誤，這筆未能判定，請人工查證。', 'An internal error prevented a verdict; verify manually.'],
  archived_other: ['網際網路檔案館 {d} 的存檔是另一份文件，與引用題名不符', 'the Internet Archive copy from {d} is a different document from the cited title'],
  url_main_only: ['頁面只出現主標題，未見引用的副標題「{x}」', 'Only the main title appears on the page; the cited subtitle “{x}” does not'],
  doi_main_only: ['DOI 導向的頁面只出現主標題，未見引用的副標題「{x}」', 'The DOI landing page shows only the main title; the cited subtitle “{x}” does not appear'],
  S_part_main_only: ['來源頁面只出現主標題，未見引用的副標題「{x}」：副標題（研究地點、範圍）可能被替換或自行添加，請人工確認。', 'Only the main title appears on the source page, not the cited subtitle “{x}”: the subtitle (study site, scope) may have been changed or added; check manually.'],
  url_echo: ['網址本身含有引用題名（搜尋頁或錯誤頁會原樣顯示查詢內容），頁面內容不能作為證據', 'The URL itself contains the cited title (search and error pages echo it back), so the page content is not evidence'],
  S_unv_echo: ['網址是會原樣顯示查詢內容的搜尋頁，無法證明文獻存在，且 {srch}，需人工查證；請改引用文獻本身的網址。', 'The URL is a search page that echoes its query, which does not show the work exists, and {srch}; verify manually and cite the work’s own URL.'],
  soft_body: ['頁面標題只有網站名稱，內文顯示「查無資料／不存在」，可能是錯誤頁', 'The page title is only the site name and the text says the content does not exist; it may be an error page'],
  S_unv_soft_body: ['網址可開啟，但頁面看起來是錯誤頁（標題只有網站名稱、內文顯示查無資料），且 {srch}，需人工查證。', 'The URL opens, but the page looks like an error page (site name as title, text says nothing was found), and {srch}; verify manually.'],
  host_fixed: ['原網址的網域無法解析；改用 {h} 後頁面內容與引用相符', 'The cited host does not resolve; at {h} the page matches the citation'],
  S_part_host_fixed: ['引用網址的主機名稱有誤（{h0} 無法解析），{h} 上的頁面與引用相符：文獻存在，請更正網址。', 'The cited host name is wrong ({h0} does not resolve), but the page at {h} matches the citation: the source exists; correct the URL.'],
  doi_extra: ['DOI 已註冊，但引用題名比登記題名多出「{x}」', 'DOI is registered, but the cited title adds “{x}” to the registered title'],
  url_extra: ['頁面題名相符，但引用題名多出「{x}」', 'The page title matches, but the cited title adds “{x}”'],
  S_part_extra: ['來源存在，但引用題名比來源多出「{x}」（來源題名：「{ft}」）：副標題或研究範圍可能是自行添加的，請人工確認。', 'The source exists, but the cited title adds “{x}” to the source title (“{ft}”): the subtitle or scope may have been added; check manually.'],
  doi_book: ['DOI 指向整本書（「{ft}」），引用的是書中章節，無法自動確認章節', 'The DOI identifies the whole book (“{ft}”); the cited chapter could not be confirmed automatically'],
  S_part_book: ['DOI 指向整本書「{ft}」，引用的是其中一章：書籍存在，但章節題名與作者需人工確認（該章若有自己的 DOI，請改用章節 DOI）。', 'The DOI identifies the whole book (“{ft}”), while the citation is to a chapter: the book exists, but the chapter title and authors need a manual check (use the chapter’s own DOI if it has one).'],
  search_similar_noauthor: ['{src} 有同名紀錄，但沒有作者資料、刊名也不同，無法確認為同一筆', '{src} lists a work with this title but no authors and a different venue, so it cannot be confirmed'],
  S_unv_similar_noauthor: ['{pre}書目資料庫只有沒有作者資料、刊名也不同的同名紀錄，無法確認為引用的著作，請人工比對建議項目。', '{pre}the databases only list a same-title record without authors and from a different venue, so it cannot be confirmed as the cited work; compare the suggestion manually.'],
  S_nf_dead_link: ['{neg}，未找到可用的網際網路檔案館存檔，且 {srch}：可能是不存在的文獻；但政府網頁、中文文獻多不在書目資料庫中，搜尋落空不能證明文獻不存在，不能排除連結失效，請至機關網站搜尋題名人工確認。', '{neg}, no usable Internet Archive copy was found, and {srch}: the reference may not exist; but government pages and Chinese-language sources are mostly absent from bibliographic databases, so an empty search does not prove the work does not exist and link rot cannot be ruled out. Search the agency site for the title.'],
  S_mis_archived: ['原網址已失效，網際網路檔案館 {d} 的存檔是另一份文件{ft}，與引用題名不符：此網址不是引用的文獻，請人工查證。', 'The link is dead, and the Internet Archive copy from {d} is a different document{ft} from the cited title: this URL is not the cited work; verify manually.'],
  S_unv_dead_link: ['{neg}，且網際網路檔案館沒有存檔；此類來源（政府網頁、中文文獻）多不在書目資料庫中，無法區分「連結失效」與「文獻不存在」，請至機關網站搜尋題名人工確認。', '{neg}, and the Internet Archive has no copy; sources of this kind are mostly absent from bibliographic databases, so link rot cannot be told apart from a non-existent work. Search the agency site for the title.'],
};

function msg(L, key, p) {
  const pair = MSG[key];
  let s = pair ? pair[L === 'en' ? 1 : 0] : key;
  if (p) s = s.replace(/\{(\w+)\}/g, (_, k) => (p[k] == null ? '' : String(p[k])));
  return s;
}

// 只供本站前端同源呼叫：不送 CORS 標頭（其他網站的頁面無法讀取回應，也無法通過 JSON 請求的預檢）
function json(status, obj, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', ...(extra || {}) },
  });
}

// 簡易頻率限制（每個執行個體各自計數；同一校園網路可能共用一個 IP，上限因此放寬）
const rateHits = new Map();
function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  if (rateHits.size > 5000) for (const [k, v] of rateHits) if (now - v[v.length - 1] > RATE_WINDOW_MS) rateHits.delete(k);
  const arr = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateHits.set(ip, arr.slice(-RATE_MAX - 1));
  return arr.length > RATE_MAX;
}

function envInt(name, def, min, max) {
  const v = parseInt(Deno.env.get(name) || '', 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
}

// ═══════════════════════════════════════════════════════════════
// 文字正規化與題名相似度
// 中日韓文字：字元雙字組（bigram）；拉丁文字：單字（不分大小寫、去變音符號與標點）
// ═══════════════════════════════════════════════════════════════
const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_RE = new RegExp(`[${CJK_CLASS}]`, 'u');
const CJK_RUNS_RE = new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'gu');
const STOPWORDS = new Set(('a an the of and or in on for to with by at from as is are be its into via about ' +
  'over under between among this that these those de la le el los las et des du der die das und von zu en y').split(' '));

const CJK_VARIANTS = { 溼: '濕', 裏: '裡', 着: '著', 綫: '線', 爲: '為', 峯: '峰', 羣: '群', 衆: '眾', 説: '說' };
// 繁→簡字形摺疊（只用於比對，顯示仍用原字）：大陸期刊的簡體登記題名 vs 報告中轉成繁體的引用題名
// （PoC 只列常用字；正式版建議由 OpenCC TSCharacters 產生完整對照表）
const TS_PAIRS = '綠绿觀观對对鳥鸟類类樣样響响態态學学報报張张偉伟華华東东區区縣县鄉乡鎮镇灣湾島岛環环護护養养農农業业園园藝艺計计設设規规劃划築筑與与為为們们這这個个發发現现動动種种結结構构變变評评價价關关係系統统網网絡络質质氣气溫温濕湿熱热連连務务療疗癒愈復复複复壓压會会認认滿满調调實实驗验預预測测時时間间塊块邊边緣缘應应棲栖獸兽魚鱼蟲虫樹树蓋盖積积數数據据資资庫库顯显異异歸归綜综進进問问題题議议範范標标準准體体經经濟济產产開开災灾風风險险韌韧適适匯汇儲储減减頂顶牆墙廣广場场擴扩遙遥圖图衛卫無无機机監监點点線线帶带斷断記记錄录識识別别鑑鉴編编瀕濒紅红書书來来優优勢势豐丰勻匀節节際际長长驅驱過过遺遗傳传組组譜谱歷历營营維维績绩給给願愿補补償偿參参協协夥伙衝冲權权陸陆陽阳陰阴雲云電电車车鐵铁橋桥廠厂礦矿漁渔獵猎專专門门館馆義义歲岁團团圍围國国圓圆嶼屿陳陈劉刘楊杨黃黄趙赵吳吴鄭郑謝谢許许蘇苏葉叶呂吕蕭萧羅罗鄧邓馮冯盧卢錢钱韓韩鍾钟顏颜龍龙賴赖餘余蔣蒋淺浅綱纲領领總总濱滨灘滩叢丛莖茎腦脑醫医藥药視视聽听覺觉讀读寫写說说話话語语詞词論论證证讓让談谈請请該该誤误選选擇择樂乐舊旧齡龄縮缩紀纪約约級级純纯細细終终絕绝隊队階阶陣阵難难雜杂雙双離离頁页項项順顺須须頻频額额飛飞飲饮飯饭馬马騎骑鬆松鬥斗麥麦黨党齊齐龜龟鹽盐麗丽黴霉壩坝溝沟漢汉潔洁澤泽濁浊濃浓爐炉爭争獨独獎奖畝亩畫画當当疊叠盡尽盤盘礎础確确礙碍禮礼禦御稱称穩稳窮穷競竞筆笔簡简簽签糧粮糾纠紋纹納纳紙纸紛纷練练織织繩绳繪绘續续罰罚習习聯联職职聲声肅肃脈脉腳脚興兴舉举艦舰艱艰莊庄萬万蔭荫薦荐藍蓝蘭兰號号蝦虾螢萤蠶蚕眾众製制襲袭見见親亲覽览觸触訂订訓训託托訪访診诊詳详誌志誕诞課课諮咨謀谋講讲豈岂豬猪貓猫貝贝負负財财貢贡貨货販贩貴贵費费貿贸賞赏購购賽赛贈赠趕赶趨趋跡迹踐践蹤踪軌轨軍军軟软較较載载輔辅輕轻輪轮輸输轉转辦办運运遠远還还郵邮釋释針针銀银銷销鋼钢錯错鏈链鎖锁鐘钟閉闭閒闲閱阅闊阔隨随隱隐雖虽雞鸡靈灵靜静頭头頸颈顧顾颱台飼饲飽饱驚惊髮发鬧闹魯鲁鮮鲜鯉鲤鯨鲸鱷鳄鴨鸭鴿鸽鵝鹅鵲鹊鶴鹤鷹鹰齒齿龐庞獼猕蛺蛱鳶鸢鴞鸮鴴鸻鷸鹬鶇鸫鵐鹀鶯莺鴉鸦鷲鹫鷗鸥鸛鹳鶚鹗鱉鳖蝸蜗鰻鳗鯽鲫鷺鹭戶户樓楼歐欧涼凉滅灭漸渐潛潜燈灯燒烧爾尔狀状獲获畢毕盜盗稅税穀谷窩窝糞粪緊紧緩缓繳缴聖圣聞闻腸肠膚肤臨临艙舱蘆芦蘋苹虛虚裝装訊讯試试詩诗詢询誘诱諸诸謂谓貧贫責责貯贮軸轴週周達达違违遞递遷迁醜丑隻只飄飘鬱郁鹼碱劑剂勞劳單单嚴严執执堅坚塗涂墾垦壞坏壽寿夠够夢梦奮奋婦妇孫孙寧宁審审寬宽導导屆届層层屬属嶺岭幫帮幹干乾干廢废強强彈弹彙汇後后徑径從从徵征慮虑慣惯懷怀戰战擁拥擊击擔担擬拟攝摄敗败敵敌於于條条極极檢检檔档櫃柜歡欢殘残殺杀沒没湧涌滯滞滲渗漲涨潰溃澀涩濾滤瀏浏決决況况';
const TS = {};
for (let i = 0; i + 1 < TS_PAIRS.length; i += 2) TS[TS_PAIRS[i]] = TS_PAIRS[i + 1];
const TS_RE = new RegExp('[' + Object.keys(TS).join('') + ']', 'gu');
const foldTS = (s) => String(s).replace(TS_RE, (ch) => TS[ch]);
// 英式／美式拼字與單複數（behaviour/behavior、modelling/modeling、spaces/space）不應拉低相似度
function stemWord(w) {
  let x = w.replace(/isation$/, 'ization').replace(/ise$/, 'ize').replace(/ised$/, 'ized').replace(/ising$/, 'izing')
    .replace(/yse$/, 'yze').replace(/elling$/, 'eling').replace(/elled$/, 'eled').replace(/([^aeiou])our$/, '$1or')
    .replace(/([^aeiou])ours$/, '$1ors').replace(/tre$/, 'ter').replace(/tres$/, 'ters').replace(/ogue$/, 'og');
  if (x.length > 4 && x.endsWith('ies')) x = x.slice(0, -3) + 'y';
  else if (x.length > 4 && /(?:ss|x|ch|sh)es$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !/(?:ss|us|is)$/.test(x)) x = x.slice(0, -1);
  return x;
}

function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/臺/g, '台')                    // 台／臺 混用極常見
    .replace(/[溼裏着綫爲峯羣衆説]/g, (ch) => CJK_VARIANTS[ch])
    .replace(TS_RE, (ch) => TS[ch])
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}+/gu, '') // 去變音符號
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s) {
  const out = [];
  for (const w of norm(s).split(' ')) {
    if (!w) continue;
    if (!CJK_RE.test(w)) { out.push(w); continue; }
    for (const run of w.match(CJK_RUNS_RE) || []) {
      if (!CJK_RE.test(run)) { out.push(run); continue; }
      if (run.length === 1) out.push(run);
      else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    }
  }
  return out;
}

function contentSet(s) {
  const t = tokens(s);
  const c = t.filter(w => CJK_RE.test(w) || (w.length > 1 && !STOPWORDS.has(w)));
  return new Set((c.length ? c : t).map(w => (CJK_RE.test(w) || /\d/.test(w) ? w : stemWord(w))));
}

function interCount(A, B) {
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n;
}

const hasCjkToken = (S) => { for (const x of S) if (CJK_RE.test(x)) return true; return false; };
// 包含式加分只給夠長的題名：3 個字以內的短題名（如 Urban heat islands）太容易被別篇論文的題名「包含」
const minContain = (S) => (hasCjkToken(S) ? 6 : 4);
const round2 = (x) => Math.round(x * 100) / 100;

// 題名相似度（0–1）：Dice 係數，並允許一方完整包含另一方（副標題、網站名稱），以長度比例折減
function titleSim(a, b) {
  const A = contentSet(a), B = contentSet(b);
  if (!A.size || !B.size) return 0;
  const i = interCount(A, B);
  let s = (2 * i) / (A.size + B.size);
  if (A.size >= minContain(A)) s = Math.max(s, (i / A.size) * Math.min(1, 0.4 + (0.6 * A.size) / B.size));
  if (B.size >= minContain(B)) s = Math.max(s, (i / B.size) * Math.min(1, 0.4 + (0.6 * B.size) / A.size));
  return round2(s);
}

// 找到的題名有多少比例出現在整筆文獻文字中（題名擷取不確定時的退路，也用來避免誤判 mismatch）
function wholeContain(found, whole) {
  const B = contentSet(found), W = contentSet(whole);
  if (!B.size || !W.size) return 0;
  if (B.size < (hasCjkToken(B) ? 6 : 4)) return 0;
  return interCount(B, W) / B.size;
}

// 題名評分：題名擷取確定 → 直接比對；不確定 → 只用整筆文字包含度，且上限 0.84（不可能構成「強相符」）
function scoreTitle(cite, found, allowWhole) {
  if (!found) return 0;
  if (cite.titleSure) return titleSim(cite.title, found);
  if (!allowWhole) return 0;
  const W = contentSet(cite.clean);
  const c = wholeContain(found, cite.clean);
  const B = contentSet(found);
  const sc = c * Math.min(1, 0.55 + (0.45 * B.size) / Math.max(1, W.size));
  // 無法擷取題名時看不到關鍵詞替換：找到的題名必須幾乎每個字詞都出現在引用中，才可能達到「相符」
  return round2(Math.min(c >= 0.95 ? 0.84 : 0.59, sc));
}

// ── 題名關鍵詞替換偵測 ──
// AI 常見的捏造：拿真實論文題名改掉地名、物種、年份（Taipei→Taichung、石虎→白鼻心、1990→2000）。
// Dice 相似度對這類替換仍有 0.6–0.91（測試：16/16 ≥ 0.6、7/16 ≥ 0.85），無法用門檻區分；
// 改以對齊兩個題名：只有「插入／刪除」（副標題、省略字詞、語序）視為正常，「雙方各有對方沒有的字詞」視為替換。
const KT_STOP = new Set([...STOPWORDS, 'case', 'study']);
const KT_FUNC = new Set([...'之的與及和以對於在其並或等与对于并']);
const KT_SPLIT_RE = new RegExp(`[${CJK_CLASS}]|[^${CJK_CLASS}]+`, 'gu');
function ktUnits(title) {
  const s = String(title || '').normalize('NFKC').replace(/臺/g, '台').replace(/[溼裏着綫爲峯羣衆説]/g, (ch) => CJK_VARIANTS[ch])
    .normalize('NFD').replace(/\p{M}+/gu, '');
  const out = [];
  let first = true;
  for (const m of s.matchAll(/[\p{L}\p{N}]+|[:：.?!]/gu)) {
    const t = m[0];
    if (/^[:：.?!]$/.test(t)) { first = true; continue; }
    if (CJK_RE.test(t)) {
      for (const part of t.match(KT_SPLIT_RE)) {
        if (CJK_RE.test(part)) { if (!KT_FUNC.has(part)) out.push({ u: foldTS(part), o: part, cjk: true }); } else out.push({ u: part.toLowerCase(), o: part, num: /\d/.test(part) });
      }
      first = false;
      continue;
    }
    const lw = t.toLowerCase();
    const proper = !first && /^\p{Lu}/u.test(t);   // APA 句首大寫：句中大寫字＝專有名詞
    first = false;
    if ((lw.length < 2 && !/\d/.test(lw)) || KT_STOP.has(lw)) continue;
    out.push({ u: /\d/.test(lw) ? lw : stemWord(lw), o: t, proper, num: /\d/.test(lw) });
  }
  return out.slice(0, 80);
}
function ktLev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// 小寫一般字的拼字差異（不含專有名詞、數字、中文）才視為同一字
const ktNear = (x, y) => !x.proper && !y.proper && !x.num && !y.num && !x.cjk && !y.cjk &&
  x.u.length >= 6 && y.u.length >= 6 && x.u.slice(0, 3) === y.u.slice(0, 3) && ktLev(x.u, y.u) <= 2;

function keyTermDiff(cited, found) {
  const A = ktUnits(cited), B = ktUnits(String(found || '').replace(/<[^<>]*>/g, ' '));
  if (!A.length || !B.length) return [];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i].u === B[j].u ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const blocks = [];
  let i = 0, j = 0, ca = [], cb = [];
  const flush = () => { if (ca.length && cb.length) blocks.push([ca, cb]); ca = []; cb = []; };
  while (i < n && j < m) {
    if (A[i].u === B[j].u) { flush(); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ca.push(A[i++]); else cb.push(B[j++]);
  }
  while (i < n) ca.push(A[i++]);
  while (j < m) cb.push(B[j++]);
  flush();
  const setA = new Set(A.map(x => x.u)), setB = new Set(B.map(x => x.u));
  const out = [];
  // 顯示用：原字形；中文單字前後各帶一字（「臺中市」／「臺北市」比「中」／「北」好懂）
  const join = (xs, all) => {
    if (!xs[0].cjk) return xs.map(x => x.o).join(' ');
    const i0 = all.indexOf(xs[0]), i1 = all.indexOf(xs[xs.length - 1]);
    return all.slice(Math.max(0, i0 - 1), i1 + 2).map(x => x.o).join('');
  };
  // 數字（年份、區間）以集合比較：對齊可能把「2000至2010」的 2010 與「2010至2020」的 2010 配對
  const numA = A.filter(x => x.num && !setB.has(x.u)), numB = B.filter(x => x.num && !setA.has(x.u));
  if (numA.length && numB.length) out.push({ cited: numA.map(x => x.o).join(' '), found: numB.map(x => x.o).join(' ') });
  // 否定詞只出現在一方（does not increase／increases）：研究結論被反轉，視為關鍵詞不同
  const NEG = new Set(['not', 'no', 'non', 'without']);
  const negA = A.filter(x => NEG.has(x.u) && !setB.has(x.u)), negB = B.filter(x => NEG.has(x.u) && !setA.has(x.u));
  if ((negA.length > 0) !== (negB.length > 0)) out.push({ cited: negA.map(x => x.o).join(' ') || '—', found: negB.map(x => x.o).join(' ') || '—' });
  for (const [bc, bf] of blocks) {
    let c = bc.filter(x => !x.num && !setB.has(x.u));      // 出現在對方其他位置＝語序不同，不算替換
    let f = bf.filter(x => !x.num && !setA.has(x.u));
    c = c.filter(x => !f.some(y => ktNear(x, y)));
    f = f.filter(y => !bc.some(x => ktNear(x, y)));
    if (c.length && f.length) out.push({ cited: join(c, A), found: join(f, B) });
  }
  // 比對時把「臺」視為「台」；顯示時還原各自原文的寫法，引號內的字詞須與原文一致
  const orig = (t, src) => (/臺/.test(src) && !/台/.test(src) ? t.replace(/台/g, '臺') : t);
  return out.map(d => ({ cited: cleanText(orig(d.cited, cited), 60), found: cleanText(orig(d.found, String(found || '')), 60) }));
}

// 題名是否有足夠鑑別度（短而一般的題名如 Urban ecology、Nature-based solutions、都市生態學 有大量同名著作）
function isDistinctive(title) {
  const S = contentSet(title);
  return hasCjkToken(S) ? S.size >= 6 : S.size >= 4;
}

// 卷期頁碼：書目資料有卷或起始頁，且引用文字在題名之後有數字時才比較；全部對不上才回傳 false
function biblioAgrees(cite, meta) {
  const vol = meta.volume && /^\d{1,5}$/.test(meta.volume) ? meta.volume : null;
  const pg = meta.firstPage && /^[A-Za-z]?\d{1,8}$/.test(meta.firstPage) ? meta.firstPage : null;
  const tail = cite.tail || '';
  if ((!vol && !pg) || !/\d/.test(tail)) return null;
  const has = (x) => new RegExp(`(?<![\\d.])${x}(?!\\d)`, 'i').test(tail);
  const res = [vol && has(vol), pg && has(pg)].filter(x => x !== null && x !== '');
  if (!res.length) return null;
  if (res.every(x => x === false)) return false;
  return res.every(x => x === true) ? true : null;
}

// 引用題名比來源多出大段字詞（自行添加的副標題、研究範圍）：來源題名幾乎完全包含於引用題名，且多出的字詞夠多
function extraTerms(citedTitle, found) {
  const A = contentSet(citedTitle), B = contentSet(found);
  if (!A.size || !B.size) return null;
  const i = interCount(A, B);
  if (i / B.size < 0.9) return null;
  const extra = A.size - i, cjk = hasCjkToken(A);
  if (extra < (cjk ? 6 : 4) || extra / A.size < 0.4) return null;
  const lc = (x) => String(x).normalize('NFKC').replace(/臺/g, '台').toLowerCase();
  const at = lc(citedTitle).indexOf(lc(found));
  const txt = at >= 0 ? citedTitle.slice(0, at) + ' ' + citedTitle.slice(at + found.length)
    : ktUnits(citedTitle).filter(x => !new Set(ktUnits(found).map(y => y.u)).has(x.u)).map(x => x.o).join(cjk ? '' : ' ');
  return cleanText(txt.replace(/^[\s:：,，、;；—–-]+|[\s:：,，、;；—–-]+$/g, ''), 60) || null;
}
// 題名在「?」「!」處被截斷時（Does X? Evidence from Y.），把下一句也納入比較，副標題的替換才看得到
function extDiff(cite, titles, container) {
  if (!cite.titleExt) return [];
  const seg = cite.titleExt.slice(cite.title.length).trim();
  if (container && titleSim(seg, container) >= 0.6) return [];
  const n = contentSet(cite.title).size;
  for (const t of titles) if (contentSet(t).size > n) { const k = keyTermDiff(cite.titleExt, t); if (k.length) return k; }
  return [];
}

function crossLanguage(cite, titles) {
  if (!cite.titleSure || !titles.length) return false;
  const c = CJK_RE.test(cite.title);
  return titles.every(t => CJK_RE.test(t) !== c);
}

// ═══════════════════════════════════════════════════════════════
// 解析 APA 7 引用文字：作者、年份、題名
// ═══════════════════════════════════════════════════════════════
const TYPE_TAG_RE = /\[(?:政府|期刊|書籍|資料庫|NGO|媒體|Gov|Journal|Book|Database|Media|未見於本次搜尋)\]|\[not among this run.?s search results\]/gi;
// 遇到全形標點（（）。，等）即停止，避免把「（2024 年擷取）」吃進網址
const DOI_IN_TEXT_RE = /\b10\.\d{4,9}\/[^\s"<>\u3000-\u303f\uff00-\uffef]+/g;
const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"\u3000-\u303f\uff00-\uffef]+/gi;
const ABBREV = new Set(['vs', 'ed', 'eds', 'vol', 'vols', 'no', 'nos', 'pp', 'jr', 'sr', 'st', 'dr', 'mr', 'mrs', 'ms',
  'inc', 'co', 'corp', 'ltd', 'al', 'rev', 'fig', 'spp', 'sp', 'ssp', 'var', 'subsp', 'approx', 'dept', 'univ',
  'e.g', 'i.e', 'etc', 'cf']);
const ORG_CJK_RE = /(局|署|部|會|院|所|中心|協會|學會|大學|學院|政府|公司|基金會|處|館|組織|聯盟|辦公室|研究室)$/;

function cutTitle(rest) {
  if (!rest) return null;
  const pairs = { '《': '》', '〈': '〉', '「': '」', '『': '』', '“': '”', '"': '"' };
  if (pairs[rest[0]]) {
    const end = rest.indexOf(pairs[rest[0]], 1);
    if (end > 1) return tidyTitle(rest.slice(1, end));
  }
  let stop = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '。') { stop = i; break; }
    const atEnd = i + 1 === rest.length || /\s/.test(rest[i + 1]);
    if ((ch === '?' || ch === '!') && atEnd) { stop = i + 1; break; }
    if (ch === '.' && atEnd) {
      const w = (rest.slice(0, i).match(/(\S+)$/) || [, ''])[1].replace(/^[(\[]/, '');
      if (/^(?:[A-Za-z]\.)*[A-Za-z]$/.test(w) || ABBREV.has(w.toLowerCase())) continue; // 縮寫（U.S.、spp.）不斷句
      stop = i; break;
    }
  }
  return tidyTitle(rest.slice(0, stop));
}

function tidyTitle(t) {
  t = String(t || '').trim()
    .replace(/\s*\[[^\]]{1,80}\]\s*$/, '')                                                    // [Report]、[Data set]
    .replace(/\s*[〔【［][^〕】］]{1,80}[〕】］]\s*$/, '')                                          // 〔碩士論文，國立臺灣大學〕、【未出版】
    .replace(/\s*[(（][^()（）]{0,40}(?:論文|thesis|dissertation)[^()（）]{0,40}[)）]\s*$/i, '')     // （未出版碩士論文）
    .replace(/\s*\((?=[^()]*(?:\d|ed\.|版|卷|期|冊|report|報告))[^()]{1,40}\)\s*$/i, '')       // (2nd ed.)、(Report No. 3)
    .replace(/^[《〈「『“"'\s]+|[》〉」』”"'\s]+$/g, '')
    .replace(/[\s.,:;]+$/, '')
    .trim();
  return t || null;
}

function isReasonableTitle(t) {
  if (!t || t.length > 300) return false;
  const n = norm(t);
  if (CJK_RE.test(n)) return n.replace(/ /g, '').length >= 4;
  return n.length >= 8 && n.split(' ').length >= 2;
}

function parseCitation(text) {
  const t = String(text || '').normalize('NFKC').replace(TYPE_TAG_RE, ' ');
  const clean = t
    .replace(URL_IN_TEXT_RE, ' ')
    .replace(/\bdoi\s*:\s*/gi, ' ')
    .replace(DOI_IN_TEXT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cite = { clean, title: null, titleSure: false, year: null, firstAuthor: null, authorIsOrg: false };
  // 年份：(2020)、(2020a)、(2020, May 3)、(2020 年 5 月)；民國年 (民國 109 年)、(109 年)；無日期 (n.d.)
  // 只接受 1500–2099，避免把卷期「224(4647)」當成年份
  let m = clean.match(/\(((?:1[5-9]|20)\d{2})[a-z]?(?:[^()\d][^()]{0,40})?\)/);
  let year = m ? +m[1] : null;
  if (!m) {
    m = clean.match(/\((?:民國\s*(\d{2,3})\s*年?|(\d{2,3})\s*年)(?:[^()\d][^()]{0,40})?\)/);
    const roc = m ? +(m[1] || m[2]) : 0;
    if (m && roc >= 60 && roc <= 150) year = roc + 1911;
    else m = clean.match(/\((?:n\.\s?d\.|nd|無日期|未註明日期|未載日期|in press|印刷中|付印中)\)/i);
  }
  if (!m) {
    // Harvard／Elsevier 匯出格式：Lin, C.-H., Huang, Y.-C., 2018. Title. Journal 31, 95–104.
    const h = clean.match(/^([^()]{2,300}?[A-Za-z.])\s*[,.]?\s+((?:1[5-9]|20)\d{2})[a-z]?\.\s+(?=\S)/);
    if (h) { m = Object.assign([h[0].slice(h[1].length)], { index: h[1].length }); year = +h[2]; }
  }
  if (!m) return cite;
  if (year && year >= 1500 && year <= 2100) cite.year = year;
  const authorsRaw = clean.slice(0, m.index);
  const authorsPart = authorsRaw.replace(/[\s.。,]+$/, '').trim();
  if (authorsPart) {
    if (CJK_RE.test(authorsPart)) {
      const first = authorsPart.split(/[、,;&]|\s+(?:and|&)\s+|與|及/)[0].trim();
      cite.firstAuthor = first.slice(0, 40) || null;
      cite.authorIsOrg = !!first && (first.length > 4 || ORG_CJK_RE.test(first));
    } else {
      cite.firstAuthor = authorsPart.split(',')[0].replace(/\s+et al\.?$/i, '').trim().slice(0, 80) || null;
      // 沒有姓名縮寫（如 J. A.）→ 視為機構作者，不做作者比對
      cite.authorIsOrg = !/\b[A-Z]\./.test(authorsRaw);
    }
  }
  const rest = clean.slice(m.index + m[0].length).replace(/^[\s.。．,:]+/, '');
  const title = cutTitle(rest);
  cite.tail = rest;
  if (title) {
    cite.title = title;
    cite.titleSure = isReasonableTitle(title);
    const ti = rest.indexOf(title);
    if (ti >= 0) cite.tail = rest.slice(ti + title.length);
    if (/[?!]$/.test(title) && ti >= 0) {
      const after = rest.slice(ti + title.length).replace(/^[\s.]+/, '');
      const seg = cutTitle(after);
      if (seg && seg.length < after.length - 2 && !/[,，]\s*\d|\d\s*\(|\bpp?\.\s*\d|\bvol\.|https?:/i.test(seg) && seg.split(/\s+/).length <= 15) cite.titleExt = title + ' ' + seg;
    }
  }
  return cite;
}

// 參考案例（kind: 'case'）：沒有作者、年份與書目；以案例名稱（title）比對所列網頁是否就是這個案例
function caseCitation(ref) {
  const clean = String(ref.text || '').normalize('NFKC').replace(URL_IN_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  let name = String(ref.title || '').normalize('NFKC').replace(URL_IN_TEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) name = name.replace(/\s*[(（][^()（）]{0,60}[)）]\s*$/, '').trim();   // （地點・年份）
  name = tidyTitle(name.replace(/[\s,，、;；|｜・·-]*(?:1[89]|20)\d{2}\s*$/, '')) || null;
  const compact = name ? norm(name).replace(/ /g, '') : '';
  const titleSure = !!name && name.length <= 200 && [...compact].length >= (CJK_RE.test(compact) ? 3 : 6);
  return { clean, title: name, titleSure, year: null, firstAuthor: null, authorIsOrg: true, tail: '', isCase: true };
}

// 中文姓氏 → 常見羅馬拼音（威妥瑪、漢語拼音、粵／閩拼法）：引用寫中文姓名、資料庫是拼音時仍可比對姓氏
const SURNAME_ROMAN_RAW = { '陳': 'chen chan tan chun', '林': 'lin lim lam', '黃': 'huang hwang wong ng ooi', '張': 'chang zhang cheung chong teo', '李': 'li lee lie ly', '王': 'wang wong ong', '吳': 'wu ng goh woo', '劉': 'liu lau lew lieu', '蔡': 'tsai cai choi chua tsay', '楊': 'yang yeung yeo young', '許': 'hsu xu hui koh khoo shu', '鄭': 'cheng zheng chang tay chen', '謝': 'hsieh xie tse chia shieh', '郭': 'kuo guo kwok kok', '洪': 'hung hong ang', '曾': 'tseng zeng tsang tzeng', '邱': 'chiu qiu yau khoo chiou', '廖': 'liao liu liew', '賴': 'lai', '周': 'chou zhou chow chew', '徐': 'hsu xu tsui chee hsiu', '蘇': 'su so soh', '葉': 'yeh ye yip yap', '莊': 'chuang zhuang chong', '呂': 'lu lyu lui', '江': 'chiang jiang kong', '何': 'ho he', '蕭': 'hsiao xiao siu', '羅': 'lo luo law loh', '高': 'kao gao ko', '潘': 'pan poon phua', '簡': 'chien jian kan', '朱': 'chu zhu choo', '鍾': 'chung zhong', '彭': 'peng pang', '游': 'yu you yew', '詹': 'chan zhan chiam', '胡': 'hu wu oh', '施': 'shih shi sze', '沈': 'shen sim shum', '余': 'yu yee yue', '盧': 'lu lo lou loo', '梁': 'liang leung neo', '趙': 'chao zhao chiu', '顏': 'yen yan gan', '柯': 'ko ke kua', '翁': 'weng ong yung', '魏': 'wei ngai', '孫': 'sun suen', '戴': 'tai dai tay', '范': 'fan huan', '方': 'fang fong png', '宋': 'sung song', '鄧': 'teng deng tang', '杜': 'tu du to', '傅': 'fu foo', '侯': 'hou hau', '曹': 'tsao cao cho', '薛': 'hsueh xue sit', '丁': 'ting ding', '卓': 'cho zhuo toh', '馬': 'ma', '阮': 'juan ruan yuen nguyen', '董': 'tung dong', '唐': 'tang tong', '溫': 'wen wan woon', '藍': 'lan lam', '蔣': 'chiang jiang', '石': 'shih shi shek', '古': 'ku gu koo', '紀': 'chi ji kee', '姚': 'yao yiu', '連': 'lien lian', '馮': 'feng fung', '歐陽': 'ouyang ou-yang auyeung', '程': 'cheng', '黎': 'li lai', '常': 'chang', '康': 'kang hong', '袁': 'yuan yuen', '田': 'tien tian', '涂': 'tu', '鄒': 'tsou zou chow', '巫': 'wu', '鐘': 'chung zhong', '童': 'tung tong', '汪': 'wang' };
const SURNAME_ROMAN = {};
for (const [k, v] of Object.entries(SURNAME_ROMAN_RAW)) { const r = v.split(' ').map(x => x.replace(/-/g, ' ')); SURNAME_ROMAN[k] = r; SURNAME_ROMAN[foldTS(k)] = r; }
function romOf(cjkName) {
  const n = cjkName.replace(/ /g, '');
  return SURNAME_ROMAN[n.slice(0, 2)] || SURNAME_ROMAN[n[0]] || null;
}
function crossScriptAgree(a, aCjk, all) {
  if (aCjk) {
    if (a.replace(/ /g, '').length > 4) return null;
    const roms = romOf(a);
    const latin = all.filter(n => !CJK_RE.test(n));
    if (!roms || !latin.length) return null;
    return latin.some(n => roms.some(r => (' ' + n + ' ').includes(' ' + r + ' ')));
  }
  const cjk = all.filter(n => CJK_RE.test(n));
  const known = cjk.map(romOf).filter(Boolean);
  if (!known.length) return null;
  const aw = a.split(' ');
  if (known.some(roms => roms.some(r => aw.includes(r) || aw.join(' ') === r))) return true;
  return known.length === cjk.length ? false : null;
}

// 作者比對：true 相符、false 衝突、null 無法比較（機構作者、中文對羅馬拼音、任一方缺資料）
function authorsAgree(cite, names) {
  if (!cite.firstAuthor || cite.authorIsOrg || !names || !names.length) return null;
  const a = norm(cite.firstAuthor);
  if (!a) return null;
  const aCjk = CJK_RE.test(a);
  const comparable = names.map(norm).filter(n => n && CJK_RE.test(n) === aCjk);
  if (!comparable.length) return crossScriptAgree(a, aCjk, names.map(norm).filter(Boolean));
  if (aCjk) {
    const ac = a.replace(/ /g, '');
    const sorted = (x) => [...x].sort().join('');
    return comparable.some(n => { const nc = n.replace(/ /g, ''); return nc.includes(ac) || (nc.length >= 2 && ac.includes(nc)) || (nc.length >= 2 && sorted(nc) === sorted(ac)); });
  }
  const aw = a.split(' ');
  return comparable.some(n => { const nw = n.split(' '); return aw.every(w => nw.includes(w)) || nw.every(w => aw.includes(w)); });
}

// ═══════════════════════════════════════════════════════════════
// 識別碼整理
// ═══════════════════════════════════════════════════════════════
// 去掉結尾標點與不成對的結尾括號（成對的括號屬於網址或 DOI 本身，例如 S0006-3207(02)00123-4）。
// 線性時間：括號只計數一次，之後逐字元往前刪並更新計數（舊寫法每刪一個「)」就重新 split 整個字串，大量「)」時為平方時間）
const TRAIL_PUNCT = new Set([...'.,;:!?\'"」』》〉。，、；：']);
const OPENERS = '([（{', CLOSERS = ')]）}';
function trimTrailing(s) {
  const open = [0, 0, 0, 0], close = [0, 0, 0, 0];
  for (let i = 0; i < s.length; i++) {
    const k = OPENERS.indexOf(s[i]);
    if (k >= 0) open[k]++;
    else { const j = CLOSERS.indexOf(s[i]); if (j >= 0) close[j]++; }
  }
  let end = s.length;
  for (;;) {
    const before = end;
    while (end > 0 && TRAIL_PUNCT.has(s[end - 1])) end--;
    for (let k = 0; k < 4; k++) {
      while (end > 0 && s[end - 1] === CLOSERS[k] && open[k] < close[k]) { close[k]--; end--; }
    }
    if (end === before) return s.slice(0, end);
  }
}

function normDoi(s) {
  let d = String(s || '').trim();
  try { d = decodeURIComponent(d); } catch (_) { /* 不是合法的百分比編碼：保留原字串 */ }
  d = d.replace(/^(?:https?:\/\/)?(?:dx\.|www\.)?doi\.org\//i, '').replace(/^doi\s*:\s*/i, '').replace(/\s+/g, '');
  d = trimTrailing(d);
  if (d.length > 200 || !/^10\.\d{4,9}\/\S+$/.test(d)) return null;
  // 「.」「..」路徑段與反斜線會被 URL 解析折疊（10.9999/x/../../../works/10.1038/… 會變成查詢另一個 DOI），
  // 也包括百分比編碼後的 %2e：一律拒絕，避免不存在的 DOI 借用真實 DOI 的書目而被判為已查證
  if (/(^|\/)\.{1,2}(\/|$)|\\/.test(d) || /%2e|%2f|%5c/i.test(d)) return null;
  return d.toLowerCase();
}

function trimUrl(u) {
  if (typeof u !== 'string') return null;
  let x = u.trim();
  if (!x || x.length > MAX_URL_CHARS) return null;
  x = trimTrailing(x);
  return /^[a-z][a-z0-9+.-]*:/i.test(x) ? x : null;
}

function collectIdentifiers(ref) {
  const dois = [], urls = [];
  const addDoi = (d) => { const n = normDoi(d); if (n && !dois.includes(n) && dois.length < MAX_DOIS_PER_REF) dois.push(n); };
  const addUrl = (u) => {
    const x = trimUrl(u);
    if (!x) return;
    if (/^https?:\/\/(?:dx\.|www\.)?doi\.org\/10\./i.test(x)) { addDoi(x); return; }
    if (!urls.includes(x) && urls.length < MAX_URLS_PER_REF) urls.push(x);
  };
  ref.dois.forEach(addDoi);
  ref.urls.forEach(addUrl);
  (ref.text.match(URL_IN_TEXT_RE) || []).forEach(addUrl);     // 前端漏抓時補上
  (ref.text.match(DOI_IN_TEXT_RE) || []).forEach(addDoi);
  return { dois, urls };
}

const encDoi = (doi) => doi.split('/').map(encodeURIComponent).join('/');
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };

// ═══════════════════════════════════════════════════════════════
// SSRF 防護：只允許 http/https、預設埠、公開位址；每一次轉址都重新檢查
// ═══════════════════════════════════════════════════════════════
function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||        // 本機、私有、多播、保留
    (a === 100 && b >= 64 && b <= 127) ||                         // CGNAT 100.64/10
    (a === 169 && b === 254) ||                                   // 鏈路本地（含雲端中繼資料 169.254.169.254）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function parseIPv6(h) {
  let s = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (s.includes('%')) return null;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...new Array(fill).fill('0'), ...tail].map(x => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return all.length === 8 && all.every(n => Number.isInteger(n)) ? all : null;
}

function ipv6Blocked(h) {
  const w = parseIPv6(h);
  if (!w) return true;
  if ((w[0] & 0xe000) !== 0x2000) return true;                    // 只允許全球單播 2000::/3（排除 ::1、ULA fc00::/7、fe80::/10、映射位址等）
  if (w[0] === 0x2001 && w[1] < 0x0200) return true;              // 2001::/23 特殊用途（含 Teredo）
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;            // 文件範例
  if (w[0] === 0x2002) return true;                               // 6to4（可夾帶私有 IPv4）
  return false;
}

// 萬用 DNS 服務（任何子網域都解析到指定或本機位址）一律不連線：DNS 檢查在部分執行環境不可用時的縱深防護
const WILDCARD_DNS = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me', 'lacolhost.com',
  'traefik.me', 'local.gd', 'localhost.direct', '1u.ms', 'rbndr.us'];
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.localdomain',
  '.home.arpa', '.arpa', '.test', '.invalid', '.example', '.onion', ...WILDCARD_DNS.map(d => '.' + d)];
const BLOCKED_NAMES = new Set(['localhost', 'instance-data', ...WILDCARD_DNS]);

function hostBlocked(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[')) return ipv6Blocked(h);
  if (/^[\d.]+$/.test(h)) return ipv4Blocked(h);                  // WHATWG URL 已把 0x7f.1、2130706433 等寫法正規化為點分十進位
  if (BLOCKED_NAMES.has(h) || !h.includes('.')) return true;      // 單一標籤（內網主機名）
  if (BLOCKED_SUFFIXES.some(s => h.endsWith(s))) return true;
  if (h === 'metadata' || h.startsWith('metadata.')) return true; // metadata.google.internal 等
  return false;
}

// 若執行環境提供 DNS 查詢，額外擋下「公開網域解析到私有位址」（DNS rebinding 的基本防護）。
// 查詢逾時或失敗時「不連線」（判為無法判定），避免惡意 DNS 以拖延回應繞過檢查；
// 只有執行環境根本不提供 DNS 查詢（API 不存在或無權限）時，才退回只做靜態檢查——回應標頭 x-verify-dns-guard 會標示 off。
// 檢查與實際連線之間的時間差（DNS rebinding）只能由平台的對外連線管制防護。
const TRUSTED_API_HOSTS = new Set(['doi.org', 'api.crossref.org', 'api.openalex.org', 'archive.org', 'web.archive.org']);
const DNS_TIMEOUT_MS = 2500;
const dnsGuard = { state: 'unknown' };     // 'on' | 'off' | 'unknown'（同一個執行個體內共用，供回應標頭與紀錄）

function dnsUnavailableError(e) {
  const name = String((e && e.name) || ''), m = String((e && e.message) || e || '');
  return /PermissionDenied|NotSupported|NotImplemented|NotCapable/i.test(name) ||
    /not (?:supported|implemented|available)|permission|requires .*allow-net|is not a function/i.test(m);
}
function dnsNotFoundError(e) {
  const name = String((e && e.name) || ''), m = String((e && e.message) || e || '');
  return /NotFound/i.test(name) || /no (?:such host|records? found)|NXDOMAIN|not found/i.test(m);
}

// 回傳 'ok' | 'blocked' | 'nxdomain' | 'error'（逾時、其他失敗）| 'skip'（不需或無法檢查）
async function dnsCheck(host) {
  const D = globalThis.Deno;
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || TRUSTED_API_HOSTS.has(host)) return 'skip';
  if (!D || typeof D.resolveDns !== 'function') { dnsGuard.state = 'off'; return 'skip'; }
  const q = (type) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ err: 'timeout' }), DNS_TIMEOUT_MS);
    Promise.resolve().then(() => D.resolveDns(host, type)).then(
      r => { clearTimeout(t); resolve({ ips: Array.isArray(r) ? r.map(String) : [] }); },
      e => { clearTimeout(t); resolve({ err: dnsUnavailableError(e) ? 'unavailable' : dnsNotFoundError(e) ? 'notfound' : 'error' }); });
  });
  const res = await Promise.all([q('A'), q('AAAA')]);
  if (res.every(r => r.err === 'unavailable')) { dnsGuard.state = 'off'; return 'skip'; }
  dnsGuard.state = 'on';
  const [a, aaaa] = res;
  if ((a.ips || []).some(ipv4Blocked) || (aaaa.ips || []).some(ipv6Blocked)) return 'blocked';
  if ((a.ips || []).length || (aaaa.ips || []).length) return 'ok';
  if (res.every(r => r.err === 'notfound' || (r.ips && !r.ips.length))) return 'nxdomain';
  return 'error';   // 無位址且至少一項查詢逾時或失敗：寧可不連線
}

async function checkTarget(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return { ok: false, code: 'invalid_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'unsafe_url' };
  if (u.username || u.password || u.port !== '') return { ok: false, code: 'unsafe_url' }; // 帶帳密或非預設埠
  if (hostBlocked(u.hostname)) return { ok: false, code: 'unsafe_url' };
  const d = await dnsCheck(u.hostname);
  if (d === 'blocked') return { ok: false, code: 'unsafe_url' };
  if (d === 'nxdomain') return { ok: false, code: 'dns_error' };
  if (d === 'error') return { ok: false, code: 'dns_check_failed' };
  u.hash = '';
  return { ok: true, href: u.href };
}

// ═══════════════════════════════════════════════════════════════
// 網路請求：每個請求獨立逾時，並受整體期限與用戶端斷線控制
// ═══════════════════════════════════════════════════════════════
function semaphore(n) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= n) await new Promise(r => queue.push(r));
    active++;
    try { return await fn(); } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

function fetchErrorCode(e, timedOut, ctx) {
  if (ctx.signal.aborted) return ctx.reason === 'client' ? 'aborted' : 'deadline';
  if (timedOut) return 'timeout';
  const parts = [];
  for (let x = e, k = 0; x && k < 4; x = x.cause, k++) parts.push(String(x.code || ''), String(x.message || x));
  const s = parts.join(' ');
  if (/EAI_AGAIN|temporary failure in name resolution/i.test(s)) return 'network_error';
  if (/ENOTFOUND|EAI_NONAME|dns error|failed to lookup address|name or service not known|nodename nor servname|no address associated|NXDOMAIN|no record found|no such host/i.test(s)) return 'dns_error';
  if (/certificate|CERT_|\btls\b|\bssl\b|handshake/i.test(s)) return 'tls_error';
  if (/ECONNREFUSED|connection refused/i.test(s)) return 'connect_error';
  if (/abort|timed? ?out/i.test(s)) return 'timeout';
  return 'network_error';
}

async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    if (n >= max) reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(n, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.byteLength, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}

async function fetchHop(url, ctx, headers, maxBytes) {
  const remaining = ctx.deadline - Date.now();
  if (ctx.signal.aborted || remaining <= 0) return { error: ctx.reason === 'client' ? 'aborted' : 'deadline' };
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(new DOMException('timeout', 'TimeoutError')); },
    Math.max(1, Math.min(ctx.upstreamMs, remaining)));
  const onAbort = () => ac.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal: ac.signal });
    if (res.type === 'opaqueredirect' || res.status === 0) return { error: 'bad_redirect' };
    if (res.status >= 300 && res.status < 400) {
      if (res.body) res.body.cancel().catch(() => {});
      return { redirect: true, status: res.status, location: res.headers.get('location') };
    }
    const ok = res.status >= 200 && res.status < 300;
    const bytes = await readCapped(res, ok ? maxBytes : Math.min(maxBytes, MAX_ERROR_BYTES));
    return {
      status: res.status,
      ok,
      ctype: (res.headers.get('content-type') || '').toLowerCase(),
      retryAfter: res.headers.get('retry-after'),
      bytes,
    };
  } catch (e) {
    return { error: fetchErrorCode(e, timedOut, ctx) };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

// 手動追蹤轉址（最多 MAX_REDIRECTS 次），每一跳都重新檢查目標是否安全。
// 同一次請求內：相同網址（與相同 Accept）只實際連線一次；對外連線總數與「每個網站」的連線數都有上限，
// 避免一次請求被放大成對單一網站的大量請求（每一跳都計數）。
const MAILTO_HOSTS = new Set(['api.crossref.org', 'api.openalex.org']);   // 只有這兩個服務會收到聯絡信箱

function safeFetch(rawUrl, ctx, headers, maxBytes, fresh) {
  if (fresh) return safeFetchUncached(rawUrl, ctx, headers, maxBytes);    // 重試（例如 429 後）不可用快取
  const key = rawUrl + '\n' + (headers.accept || '') + '\n' + maxBytes;
  let p = ctx.fetchCache.get(key);
  if (!p) { p = safeFetchUncached(rawUrl, ctx, headers, maxBytes); ctx.fetchCache.set(key, p); }
  return p;
}

function takeFetchBudget(ctx, host) {
  if (ctx.upstream >= ctx.maxUpstream) return 'upstream_budget';
  if (!TRUSTED_API_HOSTS.has(host)) {
    const n = ctx.hostHits.get(host) || 0;
    if (n >= ctx.maxHostFetches) return 'host_budget';
    ctx.hostHits.set(host, n + 1);
  }
  ctx.upstream++;
  return null;
}

async function safeFetchUncached(rawUrl, ctx, headers, maxBytes) {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    const safe = await checkTarget(url);
    if (!safe.ok) return { error: hop === 0 || /^dns_/.test(safe.code) ? safe.code : 'unsafe_redirect', url, hops: hop };
    const host = hostOf(safe.href);
    const over = takeFetchBudget(ctx, host);
    if (over) return { error: over, url: safe.href, hops: hop };
    // 轉址離開 Crossref／OpenAlex 後，不再送出含聯絡信箱的 User-Agent
    const h = MAILTO_HOSTS.has(host) ? headers : { ...headers, 'user-agent': UA };
    const r = await fetchHop(safe.href, ctx, h, maxBytes);
    if (r.error) return { ...r, url: safe.href, hops: hop };
    if (r.redirect) {
      if (!r.location) return { error: 'bad_redirect', httpStatus: r.status, url: safe.href, hops: hop };
      if (hop >= MAX_REDIRECTS) return { error: 'too_many_redirects', url: safe.href, hops: hop };
      try { url = new URL(r.location, safe.href).href; } catch (_) { return { error: 'bad_redirect', url: safe.href, hops: hop }; }
      continue;
    }
    return { ...r, url: safe.href, hops: hop };
  }
}

function apiHeaders(ctx) {
  return { 'user-agent': ctx.apiUa, accept: 'application/json' };
}
function pageHeaders() {
  return {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
    'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
  };
}

// 同步運算（書目轉換、題名比對、引用解析）計入本次請求的 CPU 預算
function timed(ctx, fn) {
  const t0 = performance.now();
  try { return fn(); } finally { ctx.cpuMs += performance.now() - t0; }
}

function parseJsonBytes(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { return null; }
}

async function apiJson(url, ctx, accept, fresh) {
  const headers = apiHeaders(ctx);
  if (accept) headers.accept = accept;
  const r = await safeFetch(url, ctx, headers, MAX_API_BYTES, fresh);
  if (r.error) return r;
  const t0 = performance.now();
  const parsed = parseJsonBytes(r.bytes);
  ctx.cpuMs += performance.now() - t0;          // JSON 解析也計入運算預算
  return { ...r, json: parsed };
}

function httpErrCode(status) {
  if (status === 404) return 'http_404';
  if (status === 410) return 'http_410';
  if (status === 401 || status === 403) return 'blocked_403';
  if (status === 429) return 'rate_limited';
  return 'http_' + status;
}

// Crossref 有併發與頻率限制：同一請求內限制同時連線數，429 時依 Retry-After 稍候重試一次
function crossrefCall(url, ctx) {
  return ctx.crossref(async () => {
    let r = await apiJson(url, ctx);
    if (r.status === 429 && !ctx.expired()) {
      const wait = Math.min(2000, Math.max(300, (parseFloat(r.retryAfter) || 1) * 1000));
      await new Promise(res => setTimeout(res, Math.min(wait, Math.max(0, ctx.deadline - Date.now()))));
      r = await apiJson(url, ctx, null, true);
    }
    return r;
  });
}

// ═══════════════════════════════════════════════════════════════
// 書目資料轉換（Crossref／CSL-JSON／OpenAlex → 統一格式）
// ═══════════════════════════════════════════════════════════════
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', middot: '·', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  times: '×', shy: '', zwj: '', zwnj: '', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', oacute: 'ó',
  uacute: 'ú', iacute: 'í', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', auml: 'ä', ccedil: 'ç', szlig: 'ß',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    const v = ENTITIES[e.toLowerCase()];
    return v != null ? v : m;
  });
}

// 對外回傳的題名一律去標籤、去控制字元、截斷——絕不回傳上游 HTML
function cleanText(s, max = MAX_FOUND_TITLE) {
  if (s == null) return null;
  // 先截斷再跑正規式（上游可送來數百 KB 的「題名」）；標籤樣式用 [^<>]：大量「<」而沒有「>」時仍是線性時間
  let t = decodeEntities(String(s).slice(0, Math.max(8 * max, 4000)).replace(/<[^<>]*>/g, ' '))
    .replace(/<[^<>]*>/g, ' ')           // 實體解碼後才出現的標籤（&lt;img…&gt;）也去掉
    .replace(/[<>]/g, ' ')
    // deno-lint-ignore no-control-regex -- 刻意移除控制字元與零寬字元
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t;
}

const strList = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : typeof v === 'string' ? [v] : []);

function yearOf(s) {
  const m = String(s || '').match(/\b(1[5-9]\d\d|20\d\d|21[0-2]\d)\b/);
  return m ? +m[1] : null;
}

function dateYear(d) {
  if (!d || typeof d !== 'object') return null;
  const dp = d['date-parts'];
  const y = Array.isArray(dp) && Array.isArray(dp[0]) ? dp[0][0] : null;
  if (Number.isInteger(y) && y >= 1500 && y <= 2200) return y;
  if (typeof y === 'string' && /^\d{4}$/.test(y)) return +y;
  return typeof d.literal === 'string' ? yearOf(d.literal) : typeof d.raw === 'string' ? yearOf(d.raw) : null;
}

// 顯示用：西文取姓；中文姓名（Crossref 常拆成 family「林」＋ given「小明」）合併為全名
function personNames(list) {
  if (!Array.isArray(list)) return [];
  return list.map(a => {
    if (!a || typeof a !== 'object') return '';
    const fam = typeof a.family === 'string' ? a.family : '';
    const giv = typeof a.given === 'string' ? a.given : '';
    if (fam && CJK_RE.test(fam + giv)) return fam + giv;
    return fam || (typeof a.name === 'string' && a.name) || (typeof a.literal === 'string' && a.literal) || '';
  }).filter(Boolean).slice(0, 20);
}
// 比對用：姓＋名全部納入（作者比對只要求引用的第一作者姓氏出現在其中）
function personFull(list) {
  if (!Array.isArray(list)) return [];
  return list.map(a => (a && typeof a === 'object'
    ? [a.family, a.given, a.name, a.literal].filter(x => typeof x === 'string' && x).join(' ')
    : '')).filter(Boolean).slice(0, 20);
}

function fmtAuthors(list) {
  if (!list || !list.length) return null;
  const s = list.slice(0, 3).join(', ') + (list.length > 3 ? ', et al.' : '');
  return cleanText(s, 200);
}

const MAX_META_TITLES = 4;             // 每個題名欄位最多取幾筆（上游可送來上萬筆的陣列）
function metaFromCrossref(m) {
  const main = strList(m.title).slice(0, MAX_META_TITLES), sub = strList(m.subtitle).slice(0, MAX_META_TITLES);
  const titles = [...main];
  if (main[0] && sub[0]) titles.push(main[0] + ': ' + sub[0]);
  titles.push(...strList(m['original-title']).slice(0, MAX_META_TITLES), ...strList(m['short-title']).slice(0, MAX_META_TITLES));
  // 線上優先出版與紙本卷期常差一年以上：任一出版日期吻合即可
  const years = [m.issued, m['published-print'], m['published-online'], m.published].map(dateYear).filter(Boolean);
  const cleaned = titles.map(t => cleanText(t)).filter(Boolean);
  for (const t of cleaned.slice()) {
    const main = t.split(/\s*[:：]\s+|\s+[–—-]\s+/)[0];
    if (main && main !== t && isReasonableTitle(main) && !cleaned.includes(main)) cleaned.push(main);
  }
  return {
    titles: cleaned,
    year: years[0] || dateYear(m.created),
    years,
    authors: personNames(m.author),
    compareNames: [...personFull(m.author), ...personFull(m.editor)],
    doi: normDoi(m.DOI),
    type: typeof m.type === 'string' ? m.type : null,
    container: cleanText(strList(m['container-title'])[0] || '') || null,
    url: typeof m.URL === 'string' ? m.URL : null,
    volume: typeof m.volume === 'string' ? m.volume.trim() : null,
    firstPage: typeof m.page === 'string' ? m.page.split(/[-–]/)[0].trim() : typeof m['article-number'] === 'string' ? m['article-number'].trim() : null,
  };
}

function metaFromCsl(m) {
  const meta = metaFromCrossref({ ...m, 'short-title': m['title-short'] || m['short-title'] });
  return meta;
}

function metaFromOpenAlex(w) {
  const authors = Array.isArray(w.authorships)
    ? w.authorships.map(a => (a && a.author && a.author.display_name) || (a && a.raw_author_name) || '').filter(Boolean).slice(0, 20)
    : [];
  const loc = w.primary_location && typeof w.primary_location === 'object' ? w.primary_location : null;
  return {
    titles: [w.title, w.display_name].filter(t => typeof t === 'string').map(t => cleanText(t)).filter(Boolean),
    year: Number.isInteger(w.publication_year) ? w.publication_year : null,
    years: Number.isInteger(w.publication_year) ? [w.publication_year] : [],
    authors,
    compareNames: authors,
    doi: normDoi(w.doi),
    type: typeof w.type === 'string' ? w.type : null,
    container: (loc && loc.source && typeof loc.source.display_name === 'string' && cleanText(loc.source.display_name)) || null,
    url: (loc && typeof loc.landing_page_url === 'string' && loc.landing_page_url) || (typeof w.id === 'string' ? w.id : null),
    volume: w.biblio && typeof w.biblio.volume === 'string' ? w.biblio.volume : null,
    firstPage: w.biblio && typeof w.biblio.first_page === 'string' ? w.biblio.first_page : null,
  };
}

function yearDiff(cite, meta) {
  const ys = meta.years && meta.years.length ? meta.years : meta.year ? [meta.year] : [];
  if (!cite.year || !ys.length) return null;
  return Math.min(...ys.map(y => Math.abs(cite.year - y)));
}

function bestOf(titles, cite, allowWhole) {
  let best = null;
  for (const t of titles) {
    const s = scoreTitle(cite, t, allowWhole);
    if (!best || s > best.score) best = { t, score: s };
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════
// 網頁／PDF 解析
// ═══════════════════════════════════════════════════════════════
const SOFT404_RE = /\b404\b|\bnot\s+found\b|page\s+(?:does\s+not|doesn['’]t)\s+exist|找不到(?:網頁|頁面|您要的|此頁|該頁|檔案)|頁面不存在|網頁不存在|查無此(?:頁|網頁|頁面)|無此頁面|頁面已(?:移除|刪除)|錯誤頁面/i;

const SOFT404_BODY_RE = /(?:資料|網頁|頁面|檔案|文章|內容)(?:已(?:經)?)?(?:不存在|已?(?:被)?(?:移除|刪除|下架|過期))|查無(?:相關|符合|任何)?(?:此)?(?:資料|網頁|頁面|檔案|文章)|找不到(?:網頁|頁面|您要|您所|該|此|指定)|(?:網頁|頁面)(?:找不到|發生錯誤)|無此(?:資料|網頁|頁面|檔案)|(?:page|content|article|document)\s+(?:you\s+(?:are\s+looking\s+for|requested)\s+)?(?:could\s+not\s+be\s+found|cannot\s+be\s+found|does\s+not\s+exist|no\s+longer\s+(?:exists|available)|has\s+been\s+removed)|\b404\b\s*(?:error|not\s+found)/i;
// 標題（或 h1）整段就是錯誤訊息才算軟 404：新聞標題「…not found after 13-year survey」、期別「第404期」不算
const SOFT404_STRICT_RE = /^(?:oops!?\s*|sorry[,!]?\s*|抱歉[，,！!]?\s*|很抱歉[，,！!]?\s*)?(?:(?:http\s*)?(?:error\s*)?404(?:\s*(?:error|not\s+found|page|錯誤))?|(?:the\s+)?(?:page|file|document|resource|content)\s+(?:was\s+|is\s+)?(?:not\s+found|(?:can['’]?t|cannot|could\s+not)\s+be\s+found|does\s*n['’o]?t\s+exist)|(?:that\s+page\s+)(?:can['’]?t|cannot|could\s+not)\s+be\s+found|not\s+found|找不到(?:網頁|頁面|您要的(?:網頁|頁面|資料)?|此頁|該頁|檔案)|(?:網頁|頁面|此頁|該頁|檔案)(?:不存在|已(?:經)?(?:不存在|移除|刪除))|查無此(?:頁|網頁|頁面)|無此頁面|錯誤頁面?|系統錯誤)[\s!！。.…:：-]*$/i;
const WAF_TITLE_RE = /^(?:Request Rejected|Access Denied|Attention Required!.*|Just a moment\.\.\.|Web Page Blocked!?|The page cannot be displayed)$/i;

// ── 防止惡意頁面耗盡 CPU（ReDoS）──
// 頁面內容不可信：以下所有正規表示式都必須是線性時間——每個起點只掃描有界長度，
// 或以 indexOf 先定位再於小片段內比對。（未閉合的 <meta、<title、<h1 重複數萬次、
// 超長屬性名稱等，在舊寫法下是平方時間，單頁可耗 CPU 數秒以上。）
const MAX_ATTR_CHARS = 8192;

function decodeHtml(bytes, ctype) {
  let cs = (ctype.match(/charset\s*=\s*["']?([\w.:-]+)/i) || [])[1];
  if (!cs) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    cs = (head.match(/<meta\b[^<>]{0,300}?charset\s*=\s*["']?([\w.:-]+)/i) || [])[1];
  }
  try { return new TextDecoder(cs || 'utf-8').decode(bytes); } catch (_) { return new TextDecoder('utf-8').decode(bytes); }
}

function parseAttrs(s) {
  const out = {};
  if (s.length > MAX_ATTR_CHARS) return out;
  // 屬性名稱只從空白、引號或斜線之後開始（後顧斷言）：超長的無「=」字串只會被掃描一次
  for (const m of s.matchAll(/(?<![^\s"'\/])([^\s=\/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4];
  }
  return out;
}

// 第一個 <tag …>…</tag> 的內容（最多 max 字元）；以單次搜尋定位開頭、結尾，線性時間
function firstTagText(s, tag, max) {
  const open = new RegExp('<' + tag + '\\b', 'i').exec(s);
  if (!open) return null;
  const gt = s.indexOf('>', open.index);
  if (gt < 0 || gt - open.index > MAX_ATTR_CHARS) return null;
  const close = new RegExp('</' + tag + '\\s*>', 'gi');
  close.lastIndex = gt + 1;
  const c = close.exec(s);
  if (!c) return null;
  return s.slice(gt + 1, Math.min(c.index, gt + 1 + max));
}

// 去除標籤取得內文：先以線性掃描跳過 script／style 等區塊（每個區塊只掃一次，未閉合就截斷），
// 再用原生正規表示式一次替換其餘標籤——避免回溯式寫法在惡意頁面上耗盡 CPU
function stripToText(html) {
  const blockRe = /<!--|<(script|style|svg|template|noscript|head)\b/gi;
  const kept = [];
  let pos = 0, m;
  while ((m = blockRe.exec(html))) {
    kept.push(html.slice(pos, m.index));
    let end;
    if (m[0] === '<!--') {
      const e = html.indexOf('-->', m.index + 4);
      end = e < 0 ? html.length : e + 3;
    } else {
      const closeRe = new RegExp('</' + m[1] + '\\s*>', 'gi');
      closeRe.lastIndex = m.index + m[0].length;
      const c = closeRe.exec(html);
      end = c ? c.index + c[0].length : html.length;
    }
    pos = end;
    if (end >= html.length) break;
    blockRe.lastIndex = end;
  }
  if (pos < html.length) kept.push(html.slice(pos));
  // 空白正規化只改「兩個以上的空白」與非一般空白字元：單一空格不必替換（大頁面上快一個數量級）
  return decodeEntities(kept.join(' ').replace(/<[a-zA-Z\/!?][^>]*>?/g, ' ')).replace(/\s{2,}|[^\S ]/g, ' ').trim().slice(0, 200000);
}

function analyzeHtml(html) {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = html.slice(0, headEnd > 0 ? Math.min(headEnd, 200000) : 200000);
  const meta = {};
  const authors = [];
  // [^<>]*：未閉合的 <meta 只掃到下一個「<」為止（線性時間）
  for (const m of head.matchAll(/<meta\b([^<>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const key = String(a.name || a.property || a.itemprop || '').toLowerCase().trim();
    if (!key || a.content == null) continue;
    if (key === 'citation_author' || key === 'dc.creator' || key === 'dcterms.creator') {
      if (authors.length < 20) { const n = cleanText(a.content, 120); if (n) authors.push(n); }
      if (key === 'citation_author') continue;   // DC.Creator 另存一份：政府網站常填機關名稱，用來辨識「網站名稱」型的 DC.Title
    }
    if (!(key in meta)) meta[key] = a.content;
  }
  const titleTag = firstTagText(html.slice(0, 300000), 'title', 2000);
  const h1 = firstTagText(html, 'h1', 2000);
  const cands = [];
  const push = (t, label, scholarly) => { const c = cleanText(t); if (c && c.length >= 2) cands.push({ t: c, label, scholarly }); };
  // 臺灣政府網站依規範每頁都有 DC.Title，但多數 CMS 填的是「網站名稱」——不能當成文獻題名去判 mismatch
  const siteNames = [meta['og:site_name'], meta['dc.publisher'], meta['dc.creator'], meta['application-name'], meta['dc.rights']]
    .map(x => (x ? norm(x) : '')).filter(x => x.length >= 2);
  const siteLike = (t) => { const n = norm(t || ''); return !!n && siteNames.some(x => n === x || n.includes(x) || x.includes(n)); };
  push(meta.citation_title, 'citation_title', true);
  const dcTitle = meta['dc.title'] || meta['dcterms.title'];
  push(dcTitle, 'dc.title', !siteLike(dcTitle) && isDistinctive(dcTitle || ''));   // 「新聞稿」「最新消息」等欄目名稱不是文獻題名
  push(meta['dcterms.alternative'], 'dc.title', false);
  push(meta['og:title'], 'og:title', false);
  push(meta['twitter:title'], 'twitter:title', false);
  const tt = cleanText(titleTag);
  if (tt) {
    push(tt, 'title', false);
    const segs = tt.split(/\s+[|｜\-–—:·•»]\s+|\s*[|｜]\s*|\s+::\s+|_/).map(s => s.trim()).filter(s => s && s !== tt);
    for (const s of segs) push(s, 'title', false);
  }
  push(h1, 'h1', false);
  // 只用「出版日期」類欄位比對年份；DC.Date／article:published_time 在政府網站常是最後更新日
  const dateKey = ['citation_publication_date', 'citation_date', 'citation_online_date', 'citation_year',
    'dcterms.issued', 'prism.publicationdate', 'dc.date.issued', 'citation_cover_date'].find(k => meta[k]);
  const segsAll = tt ? [tt, ...tt.split(/\s+[|｜\-–—:·•»]\s+|\s*[|｜]\s*|\s+::\s+|_/).map(x => x.trim()).filter(Boolean)] : [];
  const titleGeneric = !tt || segsAll.every(x => siteLike(x) || /^(?:首頁|home|homepage|index|default|main|無標題|untitled|系統訊息|錯誤訊息|訊息(?:提示|通知)?|提示訊息|錯誤|error|message|notice)$/i.test(x));
  // 頁面自己的題名（h1、og:title、dc.title 不是網站名稱或系統訊息）→ 不是錯誤頁，內文的「查無資料」多半只是空白的附件／連結區塊
  const ownTitle = cands.some(c => (c.label === 'h1' || c.label === 'og:title' || c.label === 'dc.title') && !siteLike(c.t) &&
    !/^(?:首頁|home|系統訊息|錯誤訊息|訊息|提示訊息|錯誤|error|notice)$/i.test(c.t) && !SOFT404_RE.test(c.t) && norm(c.t).replace(/ /g, '').length >= 4);
  const soft404Strict = [...segsAll.filter(x => !siteLike(x)), cleanText(h1) || ''].some(x => x && x.length <= 80 && SOFT404_STRICT_RE.test(x));
  let text = null, raw = null;
  const getText = () => (text != null ? text : (text = stripToText(html)));   // 只有題名沒對上時才需要內文
  const getRaw = () => (raw != null ? raw : (raw = lightNorm(decodeEntities(html))));
  return {
    type: 'html',
    cands,
    display: cleanText(meta.citation_title || meta['dc.title'] || meta['og:title'] || titleTag || h1),
    year: dateKey ? yearOf(meta[dateKey]) : null,
    authors,
    citationDoi: normDoi(meta.citation_doi || meta['prism.doi'] || meta['dc.identifier'] || ''),
    html,                     // 僅供內部比對，絕不回傳
    getText,
    getRaw,
    // 單頁應用程式的外殼頁通常很小；大頁面不必為此去標籤
    isJsOnly: () => html.length < 60000 && /<script\b/i.test(html) && getText().length < 200,
    soft404: soft404Strict,
    // 標題只有網站名稱、內文卻寫「資料不存在」→ 回 200 的錯誤頁（軟 404）
    softBody: () => titleGeneric && !ownTitle && SOFT404_BODY_RE.test(getText().slice(0, 8000)),
    waf: WAF_TITLE_RE.test(tt || '') || /The requested URL was rejected\. Please consult with your administrator/i.test(html.slice(0, 4000)),
  };
}

// PDF 字串在位元組層級解析（UTF-16BE 題名的位元組可能落在 0x80–0x9F，不能先轉成字元）
function pdfLiteralBytes(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c !== 0x5c) { out.push(c); continue; }
    const nx = b[++i];
    if (nx === undefined) break;
    if (nx >= 0x30 && nx <= 0x37) {
      let v = nx - 0x30;
      for (let k = 1; k < 3 && b[i + 1] >= 0x30 && b[i + 1] <= 0x37; k++) v = v * 8 + (b[++i] - 0x30);
      out.push(v & 0xff);
    } else if (nx === 0x0d || nx === 0x0a) {
      if (nx === 0x0d && b[i + 1] === 0x0a) i++;
    } else {
      const map = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
      out.push(map[nx] !== undefined ? map[nx] : nx);
    }
  }
  return pdfBytesToString(Uint8Array.from(out));
}

function pdfBytesToString(b) {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder().decode(b.subarray(3));
  return new TextDecoder('latin1').decode(b);
}

function pdfTitles(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes); // 單位元組對應單一字元，索引即位元組位置
  const out = [];
  // XMP 中繼資料（UTF-8）：先以 indexOf 定位，只在其後 3 KB 內比對（避免在惡意檔案上平方時間）
  const xi = latin.indexOf('<dc:title>');
  const x = xi >= 0 ? latin.slice(xi, xi + 3072).match(/^<dc:title>[\s\S]{0,2000}?<rdf:li[^<>]{0,300}>([\s\S]{1,1000}?)<\/rdf:li>/) : null;
  if (x) {
    const start = xi + x[0].length - '</rdf:li>'.length - x[1].length;
    out.push(decodeEntities(new TextDecoder().decode(bytes.subarray(start, start + x[1].length))));
  }
  // 文件資訊字典 /Title (literal) 或 /Title <hex>
  const t = latin.search(/\/Title\s*[(<]/);
  if (t >= 0) {
    let i = t + 6;
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
    if (bytes[i] === 0x28) {
      const buf = [];
      let depth = 1;
      for (i++; i < bytes.length && buf.length < 2000; i++) {
        const c = bytes[i];
        if (c === 0x5c && i + 1 < bytes.length) { buf.push(c, bytes[++i]); continue; }
        if (c === 0x28) depth++;
        else if (c === 0x29 && --depth === 0) break;
        buf.push(c);
      }
      out.push(pdfLiteralBytes(Uint8Array.from(buf)));
    } else if (bytes[i] === 0x3c && bytes[i + 1] !== 0x3c) {
      const end = latin.indexOf('>', i);
      if (end > i && end - i < 4000) {
        const h = latin.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
        const b = new Uint8Array(Math.floor(h.length / 2));
        for (let k = 0; k < b.length; k++) b[k] = parseInt(h.substr(k * 2, 2), 16);
        out.push(pdfBytesToString(b));
      }
    }
  }
  return out.map(s => cleanText(s))
    .filter(s => s && !/^(?:untitled|microsoft (?:word|powerpoint|excel)\b|powerpoint presentation|document\d*$|無標題|新增 microsoft)/i.test(s));
}

function analyzeFetched(fr) {
  const b = fr.bytes || new Uint8Array(0);
  const ct = fr.ctype || '';
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  if (/application\/pdf/.test(ct) || head.includes('%PDF-')) {
    return { type: 'pdf', cands: pdfTitles(b).map(t => ({ t, label: 'pdf', scholarly: false })) };
  }
  const looksHtml = /html|xml|text\/plain/.test(ct) || (!ct && /<(?:!doctype|html|head|body|title)\b/i.test(head));
  if (!looksHtml) return { type: 'other', ctype: ct.split(';')[0].trim() || 'unknown' };
  return analyzeHtml(decodeHtml(b, ct));
}

// 引用題名是否出現在頁面內文中（要求題名夠長，避免網站名稱、選單字詞造成誤判）
// 做法：把引用題名編成一個寬鬆的正規表示式（不分大小寫、台／臺 互通、字詞間容許任意標點空白），
// 直接在頁面內文上搜尋——不必把整頁做 Unicode 正規化，大頁面也只需約 1 ms
const LATIN_EXT_RE = /[À-ɏḀ-ỿ̀-ͯ]/;
function lightNorm(s) {
  let t = String(s).normalize('NFKC');
  if (LATIN_EXT_RE.test(t)) t = t.normalize('NFD').replace(/[̀-ͯ]+/g, '');
  return t;
}

function titlePattern(title, strict, relaxed) {
  const words = lightNorm(title).toLowerCase().replace(/臺/g, '台').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const compact = words.join('');
  if (relaxed) {
    // 參考案例的名稱（Superkilen、大安森林公園）是專有名詞：較短也可當作「頁面講的是這個案例」的證據
    if ([...compact].length < (CJK_RE.test(compact) ? 3 : 6)) return null;
  } else if (CJK_RE.test(compact)) {
    // 題名太短（如「臺灣生物多樣性」）幾乎每個相關網站都會出現，不能當證據
    if ([...compact].length < (strict ? 10 : 8)) return null;
  } else if (words.join(' ').length < (strict ? 25 : 20) || words.length < (strict ? 5 : 4)) {
    return null;
  }
  const SEP_ANY = '[^\\p{L}\\p{N}]*', SEP_WORD = '[^\\p{L}\\p{N}]+';
  let src = '';
  let prev = '';
  words.forEach((w, wi) => {
    [...w].forEach((ch, ci) => {
      if (prev) {
        if (CJK_RE.test(ch) || CJK_RE.test(prev)) src += SEP_ANY;
        else if (ci === 0 && wi > 0) src += SEP_WORD;
      }
      src += ch === '台' ? '[台臺]' : ch;   // norm 後只剩字母與數字，不含正規表示式特殊字元
      prev = ch;
    });
  });
  if (!CJK_RE.test(compact)) src = '(?<![\\p{L}\\p{N}])' + src + '(?![\\p{L}\\p{N}])';
  try { return new RegExp(src, 'iu'); } catch (_) { return null; }
}

// 題名中最有鑑別度的片段（拉丁：最長的 3 個字；中文：前、中、後 3 個雙字組）——全部出現才值得去標籤細比
const ANCHOR_SEP = '[^\\p{L}\\p{N}<>]{0,4}';      // 有界的分隔字元（線性時間），不跨越標籤
function titleAnchors(title) {
  const words = lightNorm(title).toLowerCase().replace(/臺/g, '台').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const compact = words.join('');
  if (CJK_RE.test(compact)) {
    // 只取題名中相鄰的兩個中文字；頁面上兩字之間可能有標點或空白（「研究：以」「生態系 保育」），比對時容許少量分隔字元
    const chars = [...compact];
    const pos = [];
    for (let i = 0; i + 1 < chars.length; i++) if (CJK_RE.test(chars[i]) && CJK_RE.test(chars[i + 1])) pos.push(i);
    if (!pos.length) return [];
    const at = [pos[0], pos[pos.length >> 1], pos[pos.length - 1]].filter((x, i, a) => a.indexOf(x) === i);
    return at.map(i => chars[i] + ANCHOR_SEP + chars[i + 1]);
  }
  return words.filter(w => w.length >= 4).sort((a, b) => b.length - a.length).slice(0, 3);
}

// 題名比對改用「正規化字串＋includes」：頁面與題名都只保留字母數字（中文題名去掉所有分隔、拉丁題名以單一空白分詞），
// 語意與 titlePattern 相同，但為線性時間——引用題名與頁面同時由他人控制時，回溯式正規表示式可能耗盡 CPU。
const MAX_TITLE_SCAN = 200000;
function compactForMatch(s, cjk) {
  const t = String(s).slice(0, MAX_TITLE_SCAN).toLowerCase().replace(/臺/g, '台');
  // 拉丁：每段非字母數字換成單一空白；本來就是單一空格者跳過不替換（省 CPU）
  return cjk ? t.replace(/[^\p{L}\p{N}]+/gu, '') : ' ' + t.replace(/(?! [\p{L}\p{N}])[^\p{L}\p{N}]+/gu, ' ') + ' ';
}
function titleNeedle(title, strict, relaxed) {
  if (!titlePattern(title, strict, relaxed)) return null;   // 沿用相同的「題名夠長才算證據」規則
  const words = lightNorm(title).toLowerCase().replace(/臺/g, '台').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const cjk = CJK_RE.test(words.join(''));
  return { cjk, s: cjk ? words.join('') : ' ' + words.join(' ') + ' ' };
}

function pageHasTitle(an, cite, noUrl) {
  if (!cite.titleSure || !an.getText) return false;
  const relax = !!cite.isCase;
  const full = titleNeedle(cite.title, false, relax);
  const main = cite.title.split(/:|：| — | – /)[0];
  const mainN = main !== cite.title ? titleNeedle(main, true, relax) : null;
  const needles = [full, mainN].filter(Boolean);
  if (!needles.length) return false;                 // 題名太短：不必讀內文
  // 1) 快速排除：有鑑別度的片段不在 HTML 中 → 去標籤後也不可能出現（不複製整頁字串，省 CPU 與記憶體）
  const anchors = titleAnchors(cite.title).map(a => new RegExp(a.replace(/台/g, '[台臺]'), 'iu'));
  const hasAnchors = (str) => anchors.every(re => re.test(str));
  if (anchors.length && !hasAnchors(an.html)) {
    // 頁面含數字實體（&#33274;）、帶重音字母或全形英數時，正規化後再確認一次
    if (!(/&#|[０-９Ａ-Ｚａ-ｚ]/.test(an.html) || LATIN_EXT_RE.test(an.html)) || !hasAnchors(an.getRaw())) return false;
  }
  const cache = an.matchCache || (an.matchCache = {});
  const hay = (which, cjk) => {
    const k = which + (cjk ? 'C' : 'L');
    if (cache[k] == null) cache[k] = compactForMatch(which === 'raw' ? an.getRaw() : lightNorm(an.getText()), cjk);
    return cache[k];
  };
  // 2) 原始 HTML（題名通常整段在同一個文字節點）；3) 題名被行內標籤切開：去標籤後再比對
  // noUrl：網址本身含有題名（slug）時只看去標籤後的內文，並去掉像網址的字串（頁面常原樣印出自己的網址）
  const hayNoUrl = (cjk) => { const k = 'U' + (cjk ? 'C' : 'L'); if (cache[k] == null) cache[k] = compactForMatch(lightNorm(an.getText()).split(' ').filter(w => !w.includes('/') && w.split('-').length < 4).join(' '), cjk); return cache[k]; };
  const hit = (n) => (noUrl ? hayNoUrl(n.cjk).includes(n.s) : hay('raw', n.cjk).includes(n.s) || hay('text', n.cjk).includes(n.s));
  if (full && hit(full)) return 'full';
  if (mainN && hit(mainN)) return 'main';   // 只有主標題出現：副標題（以OO為例）可能被替換，不能否決關鍵詞檢查
  return false;
}

// 網址本身含有引用題名（搜尋頁的查詢字串、搜尋路徑）：頁面會原樣顯示查詢內容，不能當作證據
function urlEchoesTitle(urls, cite) {
  if (!cite.titleSure) return false;
  const main = cite.title.split(/:|：| — | – /)[0];
  const relax = !!cite.isCase;
  const needles = [titleNeedle(cite.title, false, relax), main !== cite.title ? titleNeedle(main, true, relax) : null].filter(Boolean);
  if (!needles.length) return false;
  const dec = (x) => { try { return decodeURIComponent(x); } catch (_) { return x; } };
  for (const raw of urls) {
    let u;
    try { u = new URL(raw); } catch (_) { continue; }
    const path = dec(u.pathname);
    const searchy = /(?:^|\/)(?:search|query|find|results?|搜尋|查詢|检索|檢索)(?:\/|$|\.)/i.test(path) || /\/(?:search|alsearch)/i.test(path);
    const s = lightNorm(dec(u.search.replace(/\+/g, ' ')) + (searchy ? ' ' + path : ''));
    if (needles.some(n => compactForMatch(s, n.cjk).includes(n.s))) return true;
  }
  return false;
}

// 題名出現在網址路徑（slug）中
function titleInUrlPath(urls, cite) {
  if (!cite.titleSure) return false;
  const n = titleNeedle(cite.title, false, !!cite.isCase);
  if (!n) return false;
  return urls.some(raw => { try { return compactForMatch(lightNorm(decodeURIComponent(new URL(raw).pathname)), n.cjk).includes(n.s); } catch (_) { return false; } });
}

const HOME_PATH_RE = /^\/?(?:(?:index|default|home|main|mp)(?:\.\w{2,5})?|zh-tw|zh_tw|tw|ch|cht|en|zh)?\/?$/i;
const HOME_QUERY_RE = /^\?(?:lang|l|locale|mp|culture)=[\w-]+$/i;

function isHomePath(u) {
  try { const x = new URL(u); return HOME_PATH_RE.test(x.pathname) && (!x.search || HOME_QUERY_RE.test(x.search)); } catch (_) { return false; }
}

function isRedirectHome(orig, final) {
  try {
    const a = new URL(orig), b = new URL(final);
    if (a.href === b.href) return false;
    return !HOME_PATH_RE.test(a.pathname) && isHomePath(final);
  } catch (_) { return false; }
}

// ═══════════════════════════════════════════════════════════════
// 單項檢核：每項回傳 { kind, cls, reason, how, check }
//   cls：match | partial | mismatch | negative（不存在）| error（無法判定）
// ═══════════════════════════════════════════════════════════════
// 本工具自身的限制造成的「未查核」（不是來源的問題）：時間上限、用戶端中止、運算預算、連線數上限、內部錯誤
const TOOL_SIDE_CODES = new Set(['deadline', 'aborted', 'cpu_budget', 'upstream_budget', 'host_budget', 'internal_error']);
// 暫時性錯誤（逾時、連線失敗、伺服器 5xx、請求過多）：可能是對方網站一時的狀況 → 判為未完成查證時標記 transient，前端單筆重新查核一次
const TRANSIENT_CODES = new Set(['timeout', 'network_error', 'tls_error', 'rate_limited', 'http_500', 'http_502', 'http_503', 'http_504']);
const NEGATIVE_CODES = new Set(['dns_error', 'unsafe_url', 'invalid_url', 'http_404', 'http_410', 'soft_404', 'redirect_home', 'doi_not_registered', 'isbn_invalid']);

function baseCheck(kind, target) {
  return {
    kind,
    target: cleanText(String(target == null ? '' : target).slice(0, 1200), 300) || '',
    status: '',
    httpStatus: null,
    foundTitle: null,
    foundYear: null,
    foundAuthors: null,
    titleScore: null,
    note: '',
  };
}

function errorNote(L, code, httpStatus) {
  if (code === 'blocked_403') return msg(L, 'blocked_403', { code: httpStatus || 403 });
  if (/^http_\d+$/.test(code) && !MSG[code]) return msg(L, 'http_error', { code: code.slice(5) });
  if (code === 'aborted') return msg(L, 'deadline');
  return MSG[code] ? msg(L, code) : msg(L, 'network_error');
}

function shortErr(L, code) {
  if (/^http_\d+$/.test(code)) return 'HTTP ' + code.slice(5);
  if (code === 'rate_limited') return 'HTTP 429';
  if (code === 'blocked_403') return 'HTTP 403';
  const zh = { timeout: '逾時', deadline: '達時間上限', aborted: '已中止', dns_error: 'DNS', tls_error: 'TLS', bad_metadata: '回應格式異常', upstream_budget: '連線數達上限' };
  const en = { timeout: 'timeout', deadline: 'time limit', aborted: 'aborted', dns_error: 'DNS', tls_error: 'TLS', bad_metadata: 'bad response', upstream_budget: 'request limit reached' };
  return (L === 'en' ? en : zh)[code] || (L === 'en' ? 'network error' : '連線失敗');
}

function fromError(check, code, ctx, httpStatus) {
  const status = code === 'deadline' || code === 'aborted' ? 'timeout' : code;
  check.status = status;
  if (httpStatus) check.httpStatus = httpStatus;
  check.note = errorNote(ctx.lang, code, httpStatus);
  return { kind: check.kind, cls: NEGATIVE_CODES.has(status) ? 'negative' : 'error', reason: code, check };
}

// 依「書目資料」判定（Crossref、CSL-JSON、OpenAlex）
function evaluateMeta(check, meta, cite, ctx, src) {
  const L = ctx.lang;
  const best = bestOf(meta.titles, cite, true);
  check.source = src;
  check.foundTitle = best ? best.t : null;
  check.foundYear = meta.year;
  check.foundAuthors = fmtAuthors(meta.authors);
  check.titleScore = best ? best.score : null;
  const ev = { kind: check.kind, check, meta };
  if (!best) { check.status = 'doi_no_metadata'; check.note = msg(L, 'doi_no_metadata'); return { ...ev, cls: 'partial', reason: 'no_metadata' }; }
  check.status = 'doi_ok';
  // 更正／勘誤／撤稿聲明的題名常是「Correction to: 原題名」，相似度很高，但它不是原著作
  const NOTICE_RE = /^(?:correction|corrigendum|erratum|addendum|retraction(?:\s+note)?|retracted|expression\s+of\s+concern|withdrawn|notice\s+of\s+retraction)(?![a-z])|^(?:更正|勘誤|撤稿|撤回)/i;
  if (best.score >= SCORE_MATCH && NOTICE_RE.test(best.t) && !NOTICE_RE.test(cite.title || '')) {
    check.note = msg(L, 'doi_notice', { ft: best.t });
    return { ...ev, cls: 'partial', reason: 'notice', ft: best.t };
  }
  if (best.score >= SCORE_MATCH) {
    const kd = cite.titleSure ? keyTermDiff(cite.title, best.t) : [];
    const kd2 = kd.length ? kd : extDiff(cite, meta.titles, meta.container);
    if (kd2.length) {
      check.note = msg(L, 'doi_terms', { c: kd2[0].cited, f: kd2[0].found });
      return { ...ev, cls: 'partial', reason: 'terms', kc: kd2[0].cited, kf: kd2[0].found };
    }
    const x = cite.titleSure && !meta.titles.some(t => !extraTerms(cite.title, t) && titleSim(cite.title, t) >= SCORE_MATCH) ? extraTerms(cite.title, best.t) : null;
    if (x) { check.note = msg(L, 'doi_extra', { x }); return { ...ev, cls: 'partial', reason: 'extra', x, ft: best.t }; }
    const yd = yearDiff(cite, meta);
    if (yd != null && yd > YEAR_TOLERANCE) {
      check.note = msg(L, 'doi_year', { cy: cite.year, fy: meta.year });
      return { ...ev, cls: 'partial', reason: 'year', cy: cite.year, fy: meta.year };
    }
    if (authorsAgree(cite, meta.compareNames) === false) {
      check.note = msg(L, 'doi_author');
      return { ...ev, cls: 'partial', reason: 'author' };
    }
    if (biblioAgrees(cite, meta) === false) {
      check.note = msg(L, 'doi_biblio');
      return { ...ev, cls: 'partial', reason: 'biblio', vol: meta.volume || '?', pg: meta.firstPage || '?' };
    }
    check.note = msg(L, 'doi_match', { src });
    return { ...ev, cls: 'match', how: 'meta' };
  }
  // DOI 指向整本書、引用的是其中一章（APA 7 允許章節沒有 DOI 時用書的 DOI）：書名出現在引用中 → 部分查證，不是「另一篇著作」
  if (meta.type && /^(?:book|edited-book|monograph|reference-book|book-set|book-series)$/.test(meta.type) &&
      /\bIn\s.{0,160}?\((?:Eds?|編|主編)\.?\)|載於|收錄於/i.test(cite.clean)) {
    const C = contentSet(cite.clean);
    const host = meta.titles.find(t => { const T = contentSet(t); return T.size >= 2 && interCount(T, C) / T.size >= 0.8; });
    if (host) { check.note = msg(L, 'doi_book', { ft: host }); return { ...ev, cls: 'partial', reason: 'book', ft: host }; }
  }
  if (!cite.titleSure) { check.note = msg(L, 'doi_title_unsure'); return { ...ev, cls: 'partial', reason: 'title_unsure' }; }
  if (crossLanguage(cite, meta.titles)) {
    // 語言不同無法比題名：改以年份與卷期頁碼判斷（中文題名配上英文期刊的 DOI → 另一篇著作）
    const bib = biblioAgrees(cite, meta), yd = yearDiff(cite, meta);
    if (bib === false || (yd != null && yd > YEAR_TOLERANCE && bib !== true)) {
      check.note = msg(L, 'doi_cross_lang_mis');
      return { ...ev, cls: 'mismatch', reason: 'cross_lang' };
    }
    check.note = msg(L, 'doi_cross_lang'); return { ...ev, cls: 'partial', reason: 'cross_lang' };
  }
  // 找到的題名若大致出現在整筆引用文字中（題名擷取可能有誤），不判 mismatch
  const veto = meta.titles.some(t => wholeContain(t, cite.clean) >= 0.8);
  if (best.score < SCORE_MISMATCH && !veto) {
    check.note = msg(L, 'doi_wrong_work');
    return { ...ev, cls: 'mismatch' };
  }
  check.note = msg(L, 'doi_grey');
  return { ...ev, cls: 'partial', reason: 'grey' };
}

// 依「網頁／PDF 內容」判定（網址檢核，或 DOI 導向的落地頁面）
function evaluatePage(check, an, cite, ctx, fr, origUrl) {
  const L = ctx.lang;
  const isDoi = check.kind === 'doi';
  const ev = { kind: check.kind, check };
  if (an.type === 'other') {
    check.status = isDoi ? 'doi_no_metadata' : 'http_' + fr.status;
    check.note = msg(L, 'filetype', { type: an.ctype });
    return { ...ev, cls: 'partial', reason: 'filetype' };
  }
  if (an.waf) {
    check.status = 'blocked_waf'; check.note = msg(L, 'waf');
    return { ...ev, cls: 'error', reason: 'blocked_waf' };
  }
  // 標題就是錯誤訊息的頁面（Page not found）：先判定，免得頁面原樣顯示的網址被當成「內文含有題名」
  if (!isDoi && an.type === 'html' && an.soft404) { check.status = 'soft_404'; check.httpStatus = fr.status; check.note = msg(L, 'soft_404'); return { ...ev, cls: 'negative', reason: 'soft_404' }; }
  if (!isDoi && an.type === 'html' && urlEchoesTitle([origUrl, fr.url], cite)) { check.status = 'http_' + fr.status; check.note = msg(L, 'url_echo'); return { ...ev, cls: 'weak', reason: 'echo' }; }
  // 學術中繼資料（citation_title、dc.title）可用整筆文字比對；一般 <title> 不行（網站名稱常同時是作者）
  let best = null;
  for (const c of an.cands) {
    const s = scoreTitle(cite, c.t, c.scholarly);
    if (!best || s > best.score) best = { ...c, score: s };
  }
  check.titleScore = best ? best.score : null;
  if (an.type === 'pdf') {
    check.status = isDoi ? 'doi_ok' : 'pdf';
    check.foundTitle = best ? best.t : null;
    if (best && best.score >= SCORE_MATCH) {
      const kd = cite.titleSure ? keyTermDiff(cite.title, best.t) : [];
      if (kd.length) { check.note = msg(L, 'url_terms', { c: kd[0].cited, f: kd[0].found }); return { ...ev, cls: 'partial', reason: 'terms', kc: kd[0].cited, kf: kd[0].found }; }
      const x = cite.titleSure ? extraTerms(cite.title, best.t) : null;
      if (x) { check.note = msg(L, 'url_extra', { x }); return { ...ev, cls: 'partial', reason: 'extra', x, ft: best.t }; }
      check.note = isDoi ? msg(L, 'doi_landing_match') : msg(L, 'pdf_match');
      return { ...ev, cls: 'match', how: isDoi ? 'landing' : 'pdf' };
    }
    // PDF 中繼資料常是「Microsoft Word - 檔名」之類，不據以判定 mismatch
    check.note = msg(L, best ? 'pdf_title_differs' : 'pdf_nometa');
    return { ...ev, cls: 'partial', reason: 'pdf' };
  }
  check.status = isDoi ? 'doi_ok' : 'http_' + fr.status;
  check.foundTitle = best && best.score >= SCORE_MISMATCH ? best.t : an.display;
  check.foundYear = an.year;
  check.foundAuthors = fmtAuthors(an.authors);
  const titleOk = !!best && best.score >= SCORE_MATCH;
  if (titleOk && cite.titleSure) {
    let kd = keyTermDiff(cite.title, best.t);
    if (!kd.length) kd = extDiff(cite, an.cands.map(c => c.t), null);
    if (kd.length && pageHasTitle(an, cite) !== 'full') {
      check.note = msg(L, isDoi ? 'doi_terms' : 'url_terms', { c: kd[0].cited, f: kd[0].found });
      return { ...ev, cls: 'partial', reason: 'terms', kc: kd[0].cited, kf: kd[0].found };
    }
    const x = pageHasTitle(an, cite) === 'full' ? null : extraTerms(cite.title, best.t);
    if (x) { check.note = msg(L, isDoi ? 'doi_extra' : 'url_extra', { x }); return { ...ev, cls: 'partial', reason: 'extra', x, ft: best.t }; }
  }
  const slugEcho = !isDoi && titleInUrlPath([origUrl, fr.url].filter(Boolean), cite);
  const inPage = titleOk ? null : pageHasTitle(an, cite, slugEcho);   // 題名已相符就不必掃內文
  check.inPage = !!inPage;
  if (inPage === 'main' && best && best.score >= SCORE_MISMATCH) {
    const kd = keyTermDiff(cite.title, best.t);
    if (kd.length) { check.note = msg(L, isDoi ? 'doi_terms' : 'url_terms', { c: kd[0].cited, f: kd[0].found }); return { ...ev, cls: 'partial', reason: 'terms', kc: kd[0].cited, kf: kd[0].found }; }
  }
  // 頁面本身有明確、不同的學術題名（citation_title），引用題名只出現在側欄或相關文章清單 → 網址指向另一篇
  if (inPage && !titleOk && cite.titleSure && !cite.isCase) {
    const own = an.cands.filter(c => c.label === 'citation_title');
    if (own.length && !crossLanguage(cite, own.map(c => c.t)) && Math.max(...own.map(c => scoreTitle(cite, c.t, true))) < SCORE_MISMATCH) {
      check.foundTitle = own[0].t; check.note = msg(L, isDoi ? 'doi_wrong_work' : 'url_wrong_work');
      return { ...ev, cls: 'mismatch' };
    }
  }
  const movedHome = !isDoi && origUrl && isRedirectHome(origUrl, fr.url);
  if ((titleOk || inPage) && movedHome) {
    check.status = 'redirect_home';
    check.note = msg(L, 'moved_home_mentions');
    return { ...ev, cls: 'partial', reason: 'moved' };
  }
  // 網站首頁只「提到」題名（最新消息、選單）不代表引用的就是該文獻：只算部分查證
  if (inPage && !titleOk && isHomePath(fr.url)) {
    check.note = msg(L, 'home_mentions');
    return { ...ev, cls: 'partial', reason: 'home_mentions' };
  }
  // 頁面只出現主標題、沒有引用的副標題（「…：以臺中市○○為例」換成另一個研究地點，或自行添加的副標題）：不能據以查證
  if (!titleOk && inPage === 'main') {
    const main = cite.title.split(/:|：| — | – /)[0];
    const x = cleanText(cite.title.slice(main.length).replace(/^\s*(?::|：|—|–)\s*/, ''), 60);
    check.note = msg(L, isDoi ? 'doi_main_only' : 'url_main_only', { x: x || '?' });
    return { ...ev, cls: 'partial', reason: 'main_only', x: x || '?' };
  }
  if (titleOk || inPage) {
    const yd = cite.year && an.year ? Math.abs(cite.year - an.year) : null;
    if (yd != null && yd > YEAR_TOLERANCE) {
      check.note = msg(L, 'url_year', { cy: cite.year, fy: an.year });
      return { ...ev, cls: 'partial', reason: 'year', cy: cite.year, fy: an.year };
    }
    if (authorsAgree(cite, an.authors) === false) {
      check.note = msg(L, 'url_author');
      return { ...ev, cls: 'partial', reason: 'author' };
    }
    const how = isDoi ? 'landing' : titleOk ? 'meta' : 'text';
    check.note = isDoi ? msg(L, 'doi_landing_match') : msg(L, how === 'meta' ? 'url_meta_match' : 'url_in_page');
    const out = { ...ev, cls: 'match', how };
    if (an.citationDoi) out.pageDoi = an.citationDoi;
    return out;
  }
  // 只憑內文字句判斷的錯誤頁屬啟發式證據：不足以判「查無」，只算薄弱證據（→ 需人工查證）
  if (!isDoi && an.softBody && an.softBody()) { check.status = 'soft_404'; check.note = msg(L, 'soft_body'); return { ...ev, cls: 'weak', reason: 'soft_body' }; }
  if (movedHome) {
    check.status = 'redirect_home'; check.note = msg(L, 'redirect_home');
    return { ...ev, cls: 'negative', reason: 'redirect_home' };
  }
  // 引用的是網站首頁：首頁的中繼資料與內容都不是文獻本身，不構成任何證據（不判 partial／mismatch）
  // （單頁應用的 #/report/12 路由不是首頁）
  if (!isDoi && isHomePath(fr.url) && !(origUrl && /#!?\/?[^#\s]{2,}/.test(origUrl))) { check.note = msg(L, 'home_only'); return { ...ev, cls: 'weak', reason: 'home' }; }
  const scholarly = an.cands.filter(c => c.scholarly);
  if (scholarly.length && cite.titleSure && !crossLanguage(cite, scholarly.map(c => c.t))) {
    const sBest = Math.max(...scholarly.map(c => scoreTitle(cite, c.t, true)));
    const veto = scholarly.some(c => wholeContain(c.t, cite.clean) >= 0.8);
    if (sBest < SCORE_MISMATCH && !veto) {
      check.foundTitle = scholarly[0].t;
      check.note = msg(L, isDoi ? 'doi_wrong_work' : 'url_wrong_work');
      return { ...ev, cls: 'mismatch' };
    }
  }
  if (an.isJsOnly()) { check.note = msg(L, 'url_js_only'); return { ...ev, cls: 'partial', reason: 'js_only' }; }
  if (best && best.score >= SCORE_MISMATCH) { check.note = msg(L, isDoi ? 'doi_grey' : 'url_grey'); return { ...ev, cls: 'partial', reason: 'grey' }; }
  check.note = msg(L, isDoi ? 'doi_landing_unmatched' : 'url_not_in_page');
  return { ...ev, cls: 'partial', reason: 'not_in_page' };
}

async function doiHandle(doi, ctx) {
  const r = await apiJson(`https://doi.org/api/handles/${encDoi(doi)}?type=URL`, ctx);
  if (r.error) return { state: 'error', code: r.error };
  const rc = r.json && r.json.responseCode;
  if (rc === 1 || rc === 200) return { state: 'exists' };
  if (rc === 100) return { state: 'missing' };
  return { state: 'error', code: httpErrCode(r.status), httpStatus: r.status };
}

async function crossrefWork(doi, ctx) {
  const q = ctx.mailto ? `?mailto=${encodeURIComponent(ctx.mailto)}` : '';
  const r = await crossrefCall(`https://api.crossref.org/works/${encDoi(doi)}${q}`, ctx);
  if (r.error) return { state: 'error', code: r.error };
  if (r.status === 404) return { state: 'missing' };
  if (r.status === 200 && r.json && r.json.message && typeof r.json.message === 'object') {
    const meta = timed(ctx, () => metaFromCrossref(r.json.message));
    // 回傳的書目必須就是所查的 DOI（縱深防護：不讓別筆 DOI 的書目證實引用的識別碼）
    if (meta.doi && meta.doi !== doi) return { state: 'error', code: 'record_mismatch' };
    return { state: 'ok', meta };
  }
  return { state: 'error', code: r.status === 200 ? 'bad_metadata' : httpErrCode(r.status), httpStatus: r.status };
}

// doi.org 內容協商：DataCite、mEDRA、JaLC 等回傳 CSL-JSON；不支援的註冊機構會導向落地頁面
function agencyOf(url) {
  const h = hostOf(url);
  if (/(^|\.)datacite\.org$/.test(h)) return 'DataCite';
  if (/(^|\.)crossref\.org$/.test(h)) return 'Crossref';
  if (/(^|\.)medra\.org$/.test(h)) return 'mEDRA';
  if (/(^|\.)jalc\.or\.jp$/.test(h)) return 'JaLC';
  return 'doi.org';
}

async function doiContentNegotiation(doi, ctx) {
  const headers = { ...apiHeaders(ctx), accept: 'application/vnd.citationstyles.csl+json, application/citeproc+json;q=0.9, text/html;q=0.5' };
  const r = await safeFetch(`https://doi.org/${encDoi(doi)}`, ctx, headers, MAX_PAGE_BYTES);
  if (r.error) return { state: 'error', code: r.error };
  if (r.status === 404 && r.hops === 0) return { state: 'missing' };
  if (r.ok) {
    if (/json/.test(r.ctype)) {
      // 註冊機構的落地主機也可能回 JSON：解析與轉換都計入 CPU 預算
      const j = timed(ctx, () => parseJsonBytes(r.bytes));
      if (j && typeof j === 'object' && !Array.isArray(j) && (j.title || j.DOI)) {
        const meta = timed(ctx, () => metaFromCsl(j));
        if (meta.doi && meta.doi !== doi) return { state: 'error', code: 'record_mismatch' };
        return { state: 'ok', meta, src: agencyOf(r.url) };
      }
      return { state: 'error', code: 'bad_metadata' };
    }
    return { state: 'page', fr: r };
  }
  return { state: 'error', code: httpErrCode(r.status), httpStatus: r.status };
}

function openalexParams(ctx, first) {
  const p = [];
  if (ctx.mailto) p.push('mailto=' + encodeURIComponent(ctx.mailto));
  if (ctx.openalexKey) p.push('api_key=' + encodeURIComponent(ctx.openalexKey));
  return p.length ? (first ? '?' : '&') + p.join('&') : '';
}

async function openalexByDoi(doi, ctx) {
  const r = await apiJson(`https://api.openalex.org/works/doi:${encDoi(doi)}${openalexParams(ctx, true)}`, ctx);
  if (r.error) return { state: 'error', code: r.error };
  if (r.status === 404) return { state: 'missing' };
  if (r.status === 200 && r.json && (r.json.title || r.json.display_name)) {
    const meta = timed(ctx, () => metaFromOpenAlex(r.json));
    if (meta.doi && meta.doi !== doi) return { state: 'error', code: 'record_mismatch' };
    return { state: 'ok', meta };
  }
  return { state: 'error', code: r.status === 200 ? 'bad_metadata' : httpErrCode(r.status), httpStatus: r.status };
}

async function checkDoi(doi, cite, ctx) {
  const L = ctx.lang;
  const check = baseCheck('doi', doi);
  // 註冊狀態與 Crossref 書目同時查
  const [h, cr] = await Promise.all([doiHandle(doi, ctx), crossrefWork(doi, ctx)]);
  if (cr.state === 'ok') return timed(ctx, () => evaluateMeta(check, cr.meta, cite, ctx, 'Crossref'));
  if (h.state === 'missing') {
    check.status = 'doi_not_registered';
    check.httpStatus = 404;
    check.note = msg(L, 'doi_not_registered');
    check.source = 'doi.org';
    return { kind: 'doi', cls: 'negative', reason: 'doi_not_registered', check };
  }
  // 非 Crossref 的 DOI → 內容協商；Crossref 失敗（限流、逾時）→ 先用 OpenAlex
  let cnMissing = false, errCode = null, errHttp = null;
  const order = cr.state === 'missing' ? ['cn', 'oa'] : ['oa', 'cn'];
  for (const step of order) {
    if (ctx.expired()) break;
    const r = step === 'cn' ? await doiContentNegotiation(doi, ctx) : await openalexByDoi(doi, ctx);
    if (r.state === 'ok') return timed(ctx, () => evaluateMeta(check, r.meta, cite, ctx, step === 'cn' ? r.src : 'OpenAlex'));
    if (r.state === 'page') {
      check.source = 'doi.org';
      return analyzeWithBudget(check, r.fr, cite, ctx, null);
    }
    if (r.state === 'missing' && step === 'cn') cnMissing = true;
    if (r.state === 'error' && !errCode) { errCode = r.code; errHttp = r.httpStatus || null; }
  }
  if (h.state === 'exists') {
    check.status = 'doi_no_metadata';
    check.note = msg(L, 'doi_no_metadata');
    check.source = 'doi.org';
    return { kind: 'doi', cls: 'partial', reason: 'no_metadata', check };
  }
  if (cnMissing && cr.state === 'missing') {
    check.status = 'doi_not_registered';
    check.httpStatus = 404;
    check.note = msg(L, 'doi_not_registered');
    check.source = 'doi.org';
    return { kind: 'doi', cls: 'negative', reason: 'doi_not_registered', check };
  }
  const code = (cr.state === 'error' && cr.code) || errCode || (h.state === 'error' && h.code) || 'network_error';
  return fromError(check, code, ctx, cr.httpStatus || errHttp || h.httpStatus);
}

// 解析頁面是整個查核唯一吃 CPU 的步驟：累計耗時，超過預算就不再解析（判為未能判定，絕不判為已查證）
function analyzeWithBudget(check, fr, cite, ctx, origUrl) {
  if (ctx.cpuMs >= ctx.cpuBudgetMs) {
    check.status = 'cpu_budget';
    check.note = msg(ctx.lang, 'cpu_budget');
    return { kind: check.kind, cls: 'error', reason: 'cpu_budget', check };
  }
  const t0 = performance.now();
  try {
    return evaluatePage(check, analyzeFetched(fr), cite, ctx, fr, origUrl);
  } finally {
    ctx.cpuMs += performance.now() - t0;
  }
}

async function checkUrl(url, cite, ctx) {
  const check = baseCheck('url', url);
  const fr = await safeFetch(url, ctx, pageHeaders(), MAX_PAGE_BYTES);
  let ev;
  if (fr.error) ev = fromError(check, fr.error, ctx, fr.httpStatus);
  else {
    check.httpStatus = fr.status;
    ev = fr.ok ? analyzeWithBudget(check, fr, cite, ctx, url) : fromError(check, httpErrCode(fr.status), ctx, fr.status);
  }
  if (ev.cls === 'negative' && ev.check.status === 'dns_error') {
    const alt = wwwToggle(url);
    if (alt) {
      const fr2 = await safeFetch(alt, ctx, pageHeaders(), MAX_PAGE_BYTES);
      if (!fr2.error && fr2.ok) {
        const ev2 = analyzeWithBudget(baseCheck('url', alt), fr2, cite, ctx, alt);
        if (ev2.cls === 'match') {
          const h = hostOf(alt), h0 = hostOf(url);
          return { ...ev2, check: { ...ev2.check, target: cleanText(url, 300), status: 'host_fixed', note: msg(ctx.lang, 'host_fixed', { h }) }, cls: 'partial', reason: 'host_fixed', h, h0 };
        }
      }
    }
  }
  if (ev.cls === 'negative' && !['unsafe_url', 'invalid_url'].includes(ev.check.status)) ev = await waybackCheck(url, cite, ctx, ev);
  return ev;
}

function wwwToggle(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.startsWith('www.')) u.hostname = u.hostname.slice(4);
    else if (u.hostname.split('.').length >= 2) u.hostname = 'www.' + u.hostname;
    else return null;
    return u.href;
  } catch (_) { return null; }
}

// 連結失效 ≠ 文獻不存在：政府機關改組（農委會→農業部、營建署→國土管理署）後舊網址大量失效。
// 網際網路檔案館曾存檔此網址 → 網址確實存在過（捏造的路徑幾乎不可能被存檔）；存檔內容與引用相符 → 文獻存在。
async function waybackCheck(url, cite, ctx, ev) {
  if (ctx.expired()) return ev;
  const ask = async (ts) => {
    const r = await apiJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}${ts ? '&timestamp=' + ts : ''}`, ctx);
    return (!r.error && r.json && r.json.archived_snapshots && r.json.archived_snapshots.closest) || null;
  };
  const okSnap = (x) => x && x.available === true && String(x.status) === '200' && /^\d{14}$/.test(String(x.timestamp || ''));
  let c = await ask(null);
  // 最近一次存檔若已是轉址或錯誤頁（例如機關改組後），改找最接近引用年份的存檔
  if (c && !okSnap(c) && cite.year && !ctx.expired()) c = await ask(`${cite.year}0701`);
  if (!okSnap(c)) return ev;
  const ts = String(c.timestamp);
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  let matched = false;
  const fr = await safeFetch(`https://web.archive.org/web/${ts}id_/${url}`, ctx, pageHeaders(), MAX_PAGE_BYTES);
  if (!fr.error && fr.ok && ctx.cpuMs < ctx.cpuBudgetMs) {
    const t0 = performance.now();
    let e = null;
    try { e = evaluatePage(baseCheck('url', url), analyzeFetched(fr), cite, ctx, fr, url); } catch (_) { /* 存檔無法解析：只算「曾存在」 */ }
    ctx.cpuMs += performance.now() - t0;
    // 存檔本身就是「找不到」頁面（或疑似錯誤頁）：不能當作曾經存在的證據
    if (e && (e.cls === 'negative' || e.reason === 'soft_body')) return ev;
    // 存檔是另一份文件：網址曾存在，但不是引用的文獻（捏造的題名配上真實的舊網址）
    if (e && e.cls === 'mismatch') {
      const check = { ...ev.check, archived: `https://web.archive.org/web/${ts}/${url}`, foundTitle: e.check.foundTitle || null,
        note: ev.check.note + (ctx.lang === 'en' ? '; ' : '；') + msg(ctx.lang, 'archived_other', { d }) };
      return { ...ev, check, cls: 'mismatch', reason: 'archived_other', d };
    }
    matched = !!e && e.cls === 'match';
  }
  const L = ctx.lang;
  const check = { ...ev.check, archived: `https://web.archive.org/web/${ts}/${url}`,
    note: ev.check.note + (L === 'en' ? '; ' : '；') + msg(L, matched ? 'archived_match' : 'archived_nomatch', { d }) };
  return { ...ev, check, cls: matched ? 'partial' : 'weak', reason: matched ? 'archived_match' : 'archived', d, why: ev.check.note };
}

// ═══════════════════════════════════════════════════════════════
// 書目搜尋（Crossref query.bibliographic ＋ OpenAlex search）
// ═══════════════════════════════════════════════════════════════
async function crossrefSearch(q, ctx) {
  const base = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=3`;
  const mt = ctx.mailto ? `&mailto=${encodeURIComponent(ctx.mailto)}` : '';
  let r = await crossrefCall(`${base}&select=DOI,title,subtitle,author,editor,issued,type,container-title${mt}`, ctx);
  if (r.status === 400 && !ctx.expired()) r = await crossrefCall(base + mt, ctx);  // select 欄位若被拒，改不帶 select
  if (r.error) return { state: 'error', code: r.error };
  const items = r.status === 200 && r.json && r.json.message && Array.isArray(r.json.message.items) ? r.json.message.items : null;
  if (!items) return { state: 'error', code: r.status === 200 ? 'bad_metadata' : httpErrCode(r.status) };
  return { state: 'ok', items: timed(ctx, () => items.slice(0, 3).filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(metaFromCrossref)) };
}

async function openalexSearch(q, ctx) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=3` +
    `&select=id,doi,title,display_name,publication_year,authorships,primary_location${openalexParams(ctx, false)}`;
  const r = await apiJson(url, ctx);
  if (r.error) return { state: 'error', code: r.error };
  const items = r.status === 200 && r.json && Array.isArray(r.json.results) ? r.json.results : null;
  if (!items) return { state: 'error', code: r.status === 200 ? 'bad_metadata' : httpErrCode(r.status) };
  return { state: 'ok', items: timed(ctx, () => items.slice(0, 3).filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(metaFromOpenAlex)) };
}

function searchQueries(cite) {
  let full = cite.clean
    .replace(/\b(?:retrieved|accessed)\b[^.]*?\bfrom\b/gi, ' ')
    .replace(/(?:擷取|檢索)(?:日期|於|自)?[:：]?\s*\d{4}\s*年?[^。)]*/g, ' ')    // 擷取日期 2024 年 5 月 1 日
    .replace(/取自|引自|檢自/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (full.length > 300) full = full.slice(0, 300).replace(/\s+\S*$/, '');
  let title = (cite.titleSure ? cite.title : full).replace(/[|"*:?!()[\]{}\\\/<>]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (title.length > 200) title = title.slice(0, 200).replace(/\s+\S*$/, '');
  return { full, title };
}

async function searchBib(cite, ctx) {
  const L = ctx.lang;
  const { full, title } = searchQueries(cite);
  const check = baseCheck('search', cite.titleSure ? cite.title : full);
  if (!full || ctx.expired()) {
    check.status = 'search_error';
    check.note = msg(L, 'search_error', { why: msg(L, ctx.expired() ? 'deadline' : 'internal_error') });
    // 沒有可搜尋的文字（重試也不會改變）≠ 本工具的限制：不標為未查核
    return { cls: 'error', code: ctx.expired() ? 'deadline' : 'no_query', check };
  }
  const [cr, oa] = await Promise.all([crossrefSearch(full, ctx), openalexSearch(title, ctx)]);
  if (cr.state === 'error' && oa.state === 'error') {
    const code = cr.code === 'deadline' || oa.code === 'deadline' ? 'deadline' : cr.code;
    check.status = code === 'deadline' || code === 'timeout' ? 'timeout' : 'search_error';
    check.note = msg(L, 'search_error', { why: shortErr(L, code) });
    return { cls: 'error', code, check };
  }
  const cands = [];
  for (const [src, res] of [['Crossref', cr], ['OpenAlex', oa]]) {
    if (res.state !== 'ok') continue;
    for (const m of res.items) {
      if (!m.titles.length) continue;
      const best = bestOf(m.titles, cite, true);
      const yd = yearDiff(cite, m);
      const yearOk = yd != null ? yd <= YEAR_TOLERANCE : best.score >= SCORE_SEARCH_NOYEAR;
      const agree = authorsAgree(cite, m.compareNames);
      const kd = cite.titleSure && best.score >= SCORE_MATCH ? keyTermDiff(cite.title, best.t) : [];
      // 一般性短題名（Urban ecology、Nature-based solutions、都市生態學）：必須作者明確相符且年份相符才算強相符
      const generic = cite.titleSure && !isDistinctive(cite.title) && !(agree === true && yd != null && yd <= YEAR_TOLERANCE);
      // 資料庫紀錄沒有任何作者、引用有個人作者：只有刊名也相符時才算強相符（會議摘要、編者頁常是無作者的同名紀錄）
      const venueOk = m.container && cite.tail ? interCount(contentSet(m.container), contentSet(cite.tail)) / Math.max(1, contentSet(m.container).size) >= 0.8 : null;
      const noauthor = !!cite.firstAuthor && !cite.authorIsOrg && !m.compareNames.length && venueOk !== true;
      const strong = cite.titleSure && best.score >= SCORE_SEARCH_STRONG && yearOk && agree !== false && !kd.length && !generic && !noauthor;
      const why = strong ? null : !cite.titleSure || best.score < SCORE_SEARCH_STRONG ? (kd.length ? 'terms' : 'score')
        : kd.length ? 'terms' : agree === false ? 'author' : !yearOk ? 'year' : generic ? 'generic' : noauthor ? 'noauthor' : 'score';
      cands.push({ src, m, best, strong, why, kd });
    }
  }
  cands.sort((a, b) => (b.strong - a.strong) || (b.best.score - a.best.score));
  const top = cands[0];
  const failed = cr.state === 'error' ? 'Crossref' : oa.state === 'error' ? 'OpenAlex' : null;
  if (!top || top.best.score < SCORE_MATCH) {
    check.status = 'search_none';
    check.note = failed
      ? msg(L, 'search_none_half', { ok: failed === 'Crossref' ? 'OpenAlex' : 'Crossref', bad: failed })
      : msg(L, 'search_none');
    return { cls: 'none', check, half: failed };
  }
  check.source = top.src;
  check.foundTitle = top.best.t;
  check.foundYear = top.m.year;
  check.foundAuthors = fmtAuthors(top.m.authors);
  check.titleScore = top.best.score;
  const suggestion = {
    doi: top.m.doi,
    title: top.best.t,
    year: top.m.year,
    url: top.m.doi ? 'https://doi.org/' + top.m.doi : top.m.url && /^https?:\/\//i.test(top.m.url) ? cleanText(top.m.url, 500) : null,
    source: top.src,
  };
  if (top.strong) {
    check.status = 'search_match';
    check.note = msg(L, 'search_match', { src: top.src });
    return { cls: 'strong', check, suggestion, score: top.best.score };
  }
  const simKey = { author: 'search_similar_author', year: 'search_similar_year', terms: 'search_similar_terms', generic: 'search_similar_generic', noauthor: 'search_similar_noauthor' }[top.why] || 'search_similar';
  check.status = simKey;     // search_similar 或細分：_author（同名、作者不同：疑作者誤植）、_year、_terms、_generic
  check.note = msg(L, simKey, { src: top.src });
  return { cls: 'similar', check, suggestion, score: top.best.score, why: top.why, kd: top.kd };
}

// ═══════════════════════════════════════════════════════════════
// 綜合判定（保守原則：任何識別碼有誤都不給「已查證」）
// ═══════════════════════════════════════════════════════════════
function negShort(L, ev) {
  const k = 'neg_' + (ev.check.status || ev.reason);
  return MSG[k] ? msg(L, k) : ev.check.note;
}

function decide(id, evs, search, ctx, cite) {
  const L = ctx.lang;
  const checks = evs.map(e => e.check).concat(search ? [search.check] : []);
  // reason（附加欄位）：verdict 為 partial 時的細分原因（pdf、year、terms…；見 evaluateMeta／evaluatePage），其餘為 null。
  // 前端依此決定來源能否保留在報告中（排除政策），因此任何 partial 都必須帶有明確的 reason。
  // unchecked（附加欄位，只在 true 時出現）：判為 inconclusive 的原因包含本工具自身的限制（時間上限、運算預算、連線數上限、內部錯誤），
  // 而不是來源網站或書目服務的回應——前端應以較小批次重新查核，仍未查核時視同查證中斷（不得據以排除）
  const toolSide = evs.some(e => e.cls === 'error' && TOOL_SIDE_CODES.has(e.reason)) || !!(search && search.cls === 'error' && TOOL_SIDE_CODES.has(search.code));
  const transient = !toolSide && evs.some(e => e.cls === 'error' && TRANSIENT_CODES.has(e.reason));
  const out = (verdict, method, summary, suggestion, reason) => ({ id, verdict, method, reason: verdict === 'partial' ? (reason || 'unknown') : null, checks, suggestion: suggestion || null, summary,
    ...(verdict === 'inconclusive' && toolSide ? { unchecked: true } : {}), ...(verdict === 'inconclusive' && transient ? { transient: true } : {}) });
  const match = evs.find(e => e.cls === 'match');
  const doiMis = evs.find(e => e.kind === 'doi' && e.cls === 'mismatch');
  const mis = doiMis || evs.find(e => e.cls === 'mismatch');
  const doiNeg = evs.find(e => e.kind === 'doi' && e.cls === 'negative');
  const neg = doiNeg || evs.find(e => e.cls === 'negative');
  const partial = evs.find(e => e.cls === 'partial');
  const err = evs.find(e => e.cls === 'error');
  const weak = evs.find(e => e.cls === 'weak');
  const sCls = search ? search.cls : null;
  // 識別碼已證實有誤，而搜尋只找到「同名但題名過於一般」的著作 → 不足以推翻，判查無
  if (sCls === 'similar' && search.why === 'generic' && neg) return out('not_found', neg.kind, msg(L, 'S_nf_generic', { neg: neg.check.note, ft: search.check.foundTitle || '?' }));
  const citedDois = new Set(evs.filter(e => e.kind === 'doi').map(e => e.check.target));
  // 建議書目只放在結構化的 suggestion（摘要保持一句話，不重複題名與連結）
  const sug = (sCls === 'strong' || sCls === 'similar') && !(search.suggestion.doi && citedDois.has(search.suggestion.doi)) ? search.suggestion : null;
  const srch = sCls === 'none' && search.half
    ? msg(L, 'srch_none_half', { ok: search.half === 'Crossref' ? 'OpenAlex' : 'Crossref', bad: search.half })
    : msg(L, 'srch_none');

  if (match) {
    // 兩個 DOI：一個相符、另一個指向另一篇著作（常見於 AI 把兩筆文獻併成一筆）
    if (doiMis && match.kind === 'doi') return out('partial', 'doi', msg(L, 'S_part_doi_mixed', { ft: doiMis.check.foundTitle || '?' }), null, 'url_mixed');
    if (doiMis) return out('mismatch', 'doi', msg(L, 'S_mis_doi_url_ok'), sug);
    if (doiNeg) return out('partial', match.kind, msg(L, 'S_part_doi_bad_src_ok'), sug, 'doi_bad');
    if (mis) return out('partial', match.kind, msg(L, 'S_part_url_mixed', { ft: mis.check.foundTitle || '?' }), null, 'url_mixed');
    const s = match.check.titleScore != null ? match.check.titleScore.toFixed(2) : '–';
    let summary;
    if (match.kind === 'doi') summary = match.how === 'landing' ? msg(L, 'S_ver_doi_landing') : msg(L, 'S_ver_doi', { src: match.check.source || 'Crossref', s });
    else summary = msg(L, match.how === 'pdf' ? 'S_ver_url_pdf' : match.how === 'text' ? 'S_ver_url_text' : 'S_ver_url_meta', { s });
    if (neg) summary += msg(L, 'S_add_dead', { why: neg.check.note });   // 例如另一個網址 404：仍屬已查證，但點出失效連結
    // 網頁本身標示了 DOI，而引用沒附 DOI → 建議補上
    const pageSug = match.kind === 'url' && match.pageDoi && !citedDois.size
      ? { doi: match.pageDoi, title: match.check.foundTitle, year: match.check.foundYear, url: 'https://doi.org/' + match.pageDoi, source: 'citation_doi' }
      : null;
    return out('verified', match.kind, summary, pageSug);
  }
  if (mis) {
    if (mis.reason === 'archived_other') {
      const ft = mis.check.foundTitle ? (L === 'en' ? ` (“${mis.check.foundTitle}”)` : `（「${mis.check.foundTitle}」）`) : '';
      return out('mismatch', 'url', msg(L, 'S_mis_archived', { d: mis.d, ft }), sug);
    }
    const key = mis.kind === 'doi' ? (mis.reason === 'cross_lang' ? 'S_mis_doi_xlang' : 'S_mis_doi') : 'S_mis_url';
    return out('mismatch', mis.kind, msg(L, key), sug);
  }
  if (partial) {
    const p = partial.check;
    const keys = {
      year: 'S_part_year', author: 'S_part_author', grey: 'S_part_grey', title_unsure: 'S_part_title_unsure',
      cross_lang: 'S_part_cross_lang', pdf: 'S_part_pdf', js_only: 'S_part_js_only', not_in_page: 'S_part_not_in_page', moved: 'S_part_moved', home_mentions: 'S_part_home_mentions',
      no_metadata: 'S_part_no_metadata', filetype: 'S_part_filetype',
      terms: 'S_part_terms', biblio: 'S_part_biblio', archived_match: 'S_part_archived', notice: 'S_part_notice',
      extra: 'S_part_extra', book: 'S_part_book', host_fixed: 'S_part_host_fixed', main_only: 'S_part_main_only',
    };
    let summary = msg(L, keys[partial.reason] || 'S_part_grey', {
      cy: partial.cy, fy: partial.fy, fa: p.foundAuthors || '?', s: p.titleScore != null ? p.titleScore.toFixed(2) : '–',
      c: partial.kc, f: partial.kf, vol: partial.vol, pg: partial.pg, d: partial.d, why: partial.why, ft: partial.ft, x: partial.x, h: partial.h, h0: partial.h0,
    });
    if (doiNeg) summary += msg(L, 'S_add_doi_bad');
    // 引用中的 DOI 未註冊：無論其他識別碼查得什麼，這筆引用都含有錯誤的識別碼
    return out('partial', partial.kind, summary, sug, doiNeg ? 'doi_bad' : partial.reason);
  }
  // 參考案例不做書目搜尋：網址失效、只連到首頁或無法判定時，直接依網址的結果判定
  if (cite && cite.isCase) {
    if (neg) return out('not_found', neg.kind, msg(L, 'S_case_dead', { neg: neg.check.note }));
    if (err) return out('inconclusive', err.kind, msg(L, 'S_inconc', { why: err.check.note }));
    if (weak) return out('unverifiable', weak.kind, msg(L, 'S_case_weak', { why: weak.check.note }));
    return out('unverifiable', 'none', msg(L, 'S_case_nourl'));
  }
  if (sCls === 'strong') {
    if (neg) return out('partial', 'search', msg(L, 'S_part_exists_bad_id', { src: search.check.source, why: negShort(L, neg) }), sug, 'bad_id');
    const s = search.suggestion;
    const summary = msg(L, 'S_ver_search', {
      pre: err ? msg(L, 'S_pre_err') : evs.length ? '' : msg(L, 'S_pre_noid'),
      src: search.check.source,
      s: search.score.toFixed(2),
      yr: s.year ? (L === 'en' ? `, ${s.year}` : `、${s.year} 年`) : '',
    });
    return out('verified', 'search', summary, sug);
  }
  if (sCls === 'similar') {
    const s = search.score.toFixed(2);
    if (err && !neg) return out('inconclusive', err.kind, msg(L, 'S_inconc', { why: err.check.note }), sug);
    const pre = neg ? msg(L, 'S_unv_pre_neg', { neg: negShort(L, neg) }) : evs.length ? '' : msg(L, 'S_unv_pre_noid');
    const key = { author: 'S_unv_similar_author', year: 'S_unv_similar_year', terms: 'S_unv_similar_terms', generic: 'S_unv_similar_generic', noauthor: 'S_unv_similar_noauthor' }[search.why] || 'S_unv_similar';
    const kd0 = search.kd && search.kd[0];
    return out('unverifiable', 'search', msg(L, key, { pre, s, fa: search.check.foundAuthors || '?', fy: search.check.foundYear || '?', c: kd0 ? kd0.cited : '?', f: kd0 ? kd0.found : '?' }),
      search.why === 'generic' ? null : sug);
  }
  if (neg) {
    // 政府網頁、中文文獻：連結失效＋無存檔＋搜尋落空，仍可能只是連結失效（書目資料庫幾乎不收錄這類來源）
    if (sCls === 'none' && neg.kind === 'url' && ['http_404', 'http_410', 'redirect_home', 'soft_404', 'dns_error'].includes(neg.check.status) &&
        cite && (CJK_RE.test(cite.title || cite.clean) || /\.(?:gov|edu|org)\.tw$|\.gov$/.test(hostOf(neg.check.target)))) {
      return DEAD_LINK_AS_UNVERIFIABLE
        ? out('unverifiable', 'url', msg(L, 'S_unv_dead_link', { neg: neg.check.note }))
        : out('not_found', 'url', msg(L, 'S_nf_dead_link', { neg: neg.check.note, srch }));
    }
    if (sCls === 'none') return out('not_found', neg.kind, msg(L, 'S_nf', { neg: neg.check.note, srch }));
    if (doiNeg) return out('not_found', 'doi', msg(L, 'S_nf_nosearch'));
    return out('inconclusive', neg.kind, msg(L, 'S_inconc_neg_search', { neg: neg.check.note }));
  }
  if (weak) {
    if (weak.reason === 'archived') return out('unverifiable', 'url', msg(L, 'S_unv_archived', { why: weak.why, d: weak.d }));
    if (weak.reason === 'echo' && !err && sCls === 'none') return out('unverifiable', 'url', msg(L, 'S_unv_echo', { srch }));
    if (weak.reason === 'soft_body' && !err && sCls === 'none') return out('unverifiable', 'url', msg(L, 'S_unv_soft_body', { srch }));
    if (!err && sCls === 'none') return out('unverifiable', 'url', msg(L, 'S_unv_home', { srch }));
  }
  if (err) return out('inconclusive', err.kind, msg(L, 'S_inconc', { why: err.check.note }));
  if (sCls === 'none') return out('unverifiable', 'search', msg(L, 'S_unv_none', { srch }));
  if (sCls === 'error') return out('inconclusive', 'search', msg(L, 'S_inconc', { why: search.check.note }));
  return out('unverifiable', 'none', msg(L, 'S_unv_nothing'));
}

function isbnInvalid(text) {
  const m = String(text || '').normalize('NFKC').match(/ISBN(?:-1[03])?\s*[:：]?\s*([0-9][0-9\- ]{8,16}[0-9Xx])\b/);
  if (!m) return null;
  const d = m[1].replace(/[\s-]/g, '').toUpperCase();
  if (d.length === 13 && /^\d{13}$/.test(d)) {
    const s = [...d].reduce((a, x, i) => a + Number(x) * (i % 2 ? 3 : 1), 0);
    return s % 10 === 0 ? null : m[1].trim();
  }
  if (d.length === 10 && /^\d{9}[\dX]$/.test(d)) {
    const s = [...d].reduce((a, x, i) => a + (x === 'X' ? 10 : Number(x)) * (10 - i), 0);
    return s % 11 === 0 ? null : m[1].trim();
  }
  return null;
}

async function verifyRef(ref, ctx) {
  if (ctx.expired()) {
    return { id: ref.id, verdict: 'inconclusive', method: 'none', reason: null, checks: [], suggestion: null, summary: msg(ctx.lang, 'S_deadline'), unchecked: true };
  }
  const isCase = ref.kind === 'case';
  const cite = timed(ctx, () => (isCase ? caseCitation(ref) : parseCitation(ref.text)));
  const { dois, urls } = timed(ctx, () => collectIdentifiers(ref));
  const evs = [];
  // 1. DOI（最權威）：每一個都查（AI 常把兩筆文獻併成一筆：第一個 DOI 相符，不代表第二個也是這篇）
  for (const doi of dois) evs.push(await checkDoi(doi, cite, ctx));
  const doiMatched = evs.some(e => e.kind === 'doi' && e.cls === 'match');
  // 2. 網址：每一個都查；已有相符的識別碼後，其他網址只記錄失效或指向另一篇著作（不影響相符本身，但會標示）
  let matched = doiMatched;
  for (const u of urls) {
    const ev = await checkUrl(u, cite, ctx);
    if (matched) { if (ev.cls === 'negative' || ev.cls === 'mismatch') evs.push(ev); continue; }
    evs.push(ev);
    if (ev.cls === 'match') matched = true;
  }
  // ISBN 檢查碼：捏造的 ISBN 常常檢查碼錯誤
  const isbn = isCase ? null : isbnInvalid(ref.text);
  if (isbn) {
    const check = baseCheck('search', 'ISBN ' + isbn);
    check.status = 'isbn_invalid';
    check.note = msg(ctx.lang, 'isbn_invalid', { isbn });
    evs.push({ kind: 'search', cls: 'negative', reason: 'isbn_invalid', check });
  }
  // 3. 書目搜尋：未相符、或 DOI 有誤（需找出正確版本）時才搜尋
  const urlMatched = evs.some(e => e.kind === 'url' && e.cls === 'match');
  const doiFlawed = evs.some(e => e.kind === 'doi' && (e.cls === 'negative' || e.cls === 'mismatch'));
  // DOI 已確認是這篇著作（題名相符，只是年份或作者不符）→ 搜尋只會找到同一筆，省下查詢額度
  const doiIdentified = evs.some(e => e.kind === 'doi' && e.cls === 'partial' && (e.reason === 'year' || e.reason === 'author'));
  let search = null;
  // 參考案例：書目資料庫不收錄案例，搜尋案例名稱只會找到不相干的論文 → 只依所列網址判定
  if (!isCase && !doiMatched && !doiIdentified && (!urlMatched || doiFlawed)) search = await searchBib(cite, ctx);
  return decide(ref.id, evs, search, ctx, cite);
}

// ═══════════════════════════════════════════════════════════════
// 請求驗證
// ═══════════════════════════════════════════════════════════════
async function readBodyCapped(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function validateRefs(refs, L) {
  if (!Array.isArray(refs) || refs.length === 0) return { status: 400, error: msg(L, 'no_refs'), code: 'NO_REFS' };
  if (refs.length > MAX_REFS) return { status: 413, error: msg(L, 'too_many_refs', { n: refs.length, max: MAX_REFS }), code: 'TOO_MANY_REFS' };
  const ids = new Set();
  const out = [];
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    const bad = (why) => ({ status: 400, error: msg(L, 'bad_ref', { i: i + 1, why }), code: 'BAD_REF' });
    if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('not an object');
    if (typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.id)) return bad('id');
    if (ids.has(r.id)) return bad('duplicate id');
    ids.add(r.id);
    if (typeof r.text !== 'string' || !r.text.trim()) return bad('text');
    if (r.text.length > HARD_TEXT_CHARS) return { status: 413, error: msg(L, 'bad_ref', { i: i + 1, why: 'text too long' }), code: 'TEXT_TOO_LONG' };
    for (const k of ['urls', 'dois']) {
      if (r[k] == null) continue;
      if (!Array.isArray(r[k]) || r[k].length > MAX_LIST_ITEMS || r[k].some(x => typeof x !== 'string' || x.length > MAX_URL_CHARS)) return bad(k);
    }
    // 選填：kind 'ref'（預設，APA 文獻）或 'case'（參考案例表的一列；title 為案例名稱）
    if (r.kind != null && r.kind !== 'ref' && r.kind !== 'case') return bad('kind');
    if (r.title != null && (typeof r.title !== 'string' || r.title.length > MAX_FOUND_TITLE)) return bad('title');
    out.push({
      id: r.id,
      kind: r.kind === 'case' ? 'case' : 'ref',
      title: r.kind === 'case' && typeof r.title === 'string' ? r.title.trim() : '',
      text: r.text.trim().slice(0, MAX_TEXT_CHARS),
      urls: (r.urls || []).slice(0, MAX_URLS_PER_REF),
      // 超長的 DOI 字串不可能是合法 DOI：直接捨棄，不進入任何解析
      dois: (r.dois || []).filter(d => d.length <= MAX_DOI_CHARS).slice(0, MAX_DOIS_PER_REF),
    });
  }
  return { refs: out };
}

function makeCtx(lang, nRefs) {
  const mailtoRaw = (Deno.env.get('VERIFY_MAILTO') || '').trim();
  const mailto = /^[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+$/.test(mailtoRaw) ? mailtoRaw : '';
  const totalMs = envInt('VERIFY_TOTAL_TIMEOUT_MS', TOTAL_TIMEOUT_MS, 200, TOTAL_TIMEOUT_MS);
  const ac = new AbortController();
  const ctx = {
    lang,
    mailto,
    openalexKey: (Deno.env.get('VERIFY_OPENALEX_KEY') || '').trim(),
    apiUa: mailto ? UA.replace(/\)$/, `; mailto:${mailto})`) : UA,
    upstreamMs: envInt('VERIFY_UPSTREAM_TIMEOUT_MS', UPSTREAM_TIMEOUT_MS, 50, UPSTREAM_TIMEOUT_MS),
    deadline: Date.now() + totalMs,
    signal: ac.signal,
    reason: null,
    cancelled: false,
    crossref: semaphore(mailto ? 3 : 2),
    fetchCache: new Map(),       // 同一請求內相同網址只連線一次
    hostHits: new Map(),         // 每個網站的連線次數
    maxHostFetches: Math.max(MAX_HOST_FETCHES, Math.min(48, 12 + 3 * (nRefs || 1))),
    upstream: 0,
    maxUpstream: Math.min(UPSTREAM_MAX, UPSTREAM_BASE + UPSTREAM_PER_REF * (nRefs || 1)),
    cpuMs: 0,
    cpuBudgetMs: envInt('VERIFY_CPU_BUDGET_MS', CPU_BUDGET_MS, 0, 1000),
    cancel(reason) {
      if (reason === 'client') ctx.cancelled = true;   // 期限到了之後才斷線，也要停止
      if (ctx.reason) return;
      ctx.reason = reason;
      ac.abort(new DOMException(reason, 'AbortError'));
    },
    expired() { return ctx.reason != null || Date.now() >= ctx.deadline; },
  };
  ctx.timer = setTimeout(() => ctx.cancel('deadline'), totalMs);
  return ctx;
}

export default async (request, context) => {
  if (request.method !== 'POST') return json(405, { error: msg('zh', 'bad_method'), code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });

  // 未設定通行碼時不開放：本端點會代為連線任意網址，沒有 API 費用可當煞車（與 analyze 不同）
  const PASSCODE = Deno.env.get('QI_PASSCODE');
  if (!PASSCODE) return json(503, { error: msg('zh', 'not_configured'), code: 'NOT_CONFIGURED' });

  const ip = (context && typeof context.ip === 'string' && context.ip) ||
    request.headers.get('x-nf-client-connection-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (rateLimited(ip)) return json(429, { error: msg('zh', 'rate_limited_req'), code: 'RATE_LIMITED' }, { 'retry-after': '60' });

  // 只接受 JSON：跨站的 text/plain 表單請求不會被處理
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return json(415, { error: msg('zh', 'bad_ctype'), code: 'BAD_CONTENT_TYPE' });
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return json(413, { error: msg('zh', 'body_too_large'), code: 'BODY_TOO_LARGE' });
  let raw;
  try { raw = await readBodyCapped(request, MAX_BODY_BYTES); } catch (_) { raw = undefined; }
  if (raw === null) return json(413, { error: msg('zh', 'body_too_large'), code: 'BODY_TOO_LARGE' });
  let body;
  try { body = JSON.parse(raw); } catch (_) { return json(400, { error: msg('zh', 'bad_json'), code: 'BAD_JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: msg('zh', 'bad_body'), code: 'BAD_BODY' });
  const L = body.lang === 'en' ? 'en' : 'zh';

  // ── 通行碼驗證（與 analyze 相同；非字串一律視為未提供）──
  const given = typeof body.passcode === 'string' ? body.passcode.trim() : '';
  if (!given) return json(401, { error: msg(L, 'passcode_required'), code: 'PASSCODE_REQUIRED' });
  if (given !== PASSCODE) return json(401, { error: msg(L, 'passcode_invalid'), code: 'PASSCODE_INVALID' });

  const v = validateRefs(body.refs, L);
  if (v.error) return json(v.status, { error: v.error, code: v.code });

  const started = Date.now();
  const ctx = makeCtx(L, v.refs.length);
  const enc = new TextEncoder();
  const stats = { verified: 0, partial: 0, mismatch: 0, not_found: 0, unverifiable: 0, inconclusive: 0 };
  if (request.signal && typeof request.signal.addEventListener === 'function') {
    request.signal.addEventListener('abort', () => ctx.cancel('client'), { once: true });
  }

  const stream = new ReadableStream({
    start(controller) {
      const emit = (obj) => {
        if (ctx.cancelled) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch (_) { ctx.cancel('client'); }
      };
      let next = 0;
      const worker = async () => {
        while (!ctx.cancelled) {
          const i = next++;
          if (i >= v.refs.length) return;
          const ref = v.refs[i];
          let res;
          try { res = await verifyRef(ref, ctx); } catch (_) {
            res = { id: ref.id, verdict: 'inconclusive', method: 'none', reason: null, checks: [], suggestion: null, summary: msg(L, 'S_internal'), unchecked: true };
          }
          if (ctx.cancelled) return;
          if (!VERDICTS.includes(res.verdict)) { res.verdict = 'inconclusive'; res.unchecked = true; }
          if (res.verdict !== 'inconclusive') delete res.unchecked;
          if (res.verdict !== 'partial') res.reason = null;
          else if (typeof res.reason !== 'string' || !res.reason) res.reason = 'unknown';
          stats[res.verdict]++;
          emit(res);
        }
      };
      Promise.all(Array.from({ length: Math.min(REF_CONCURRENCY, v.refs.length) }, worker)).catch(() => {
        /* 個別查核的錯誤已在 worker 內處理；這裡只確保最後一行一定送出 */
      }).then(() => {
        clearTimeout(ctx.timer);
        if (ctx.cancelled) return;
        // guard.dns：本次請求中 DNS 防護是否實際運作（部署後確認 Deno.resolveDns 可用性）
        emit({ done: true, stats: { ...stats, ms: Date.now() - started }, guard: { dns: dnsGuard.state, upstream: ctx.upstream } });
        try { controller.close(); } catch (_) { /* 用戶端已斷線 */ }
      });
    },
    cancel() {
      clearTimeout(ctx.timer);
      ctx.cancel('client');   // 用戶端斷線：中止所有進行中的請求，不再開始新的查核
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      // DNS 防護是否實際運作（on／off；unknown＝本次未查詢任何網站）：部署後可由此確認 Deno.resolveDns 是否可用
      'x-verify-dns-guard': dnsGuard.state,
    },
  });
};

export const config = { path: '/api/verify' };

# 棲共生 Qi-Coexistence v1.33

景觀生態共存設計工作流工具 · eco4design.healsdesign.org
國立臺灣大學 園藝暨景觀學系 · HEALS Design System

---

## 這是什麼

輸入基地位置與焦點物種，工具會自動蒐集在地生態資料（iNaturalist 物種觀察、TBN 物種紀錄、
OpenStreetMap 環境特徵、Sentinel-2 衛星影像的植生與景觀結構），再交由 Claude 生成完整的生態共存設計分析報告。

**使用者不需自備 API 金鑰**，只需輸入授課教師提供的通行碼。

---

## 六步驟工作流

1. **選擇基地位置** — 地圖點選、地名搜尋（Nominatim）、或輸入經緯度
2. **焦點物種** — iNaturalist 自動載入在地觀察 + 預設組合 + 自訂輸入；
   觀察卡片標出臺灣特有種與保育類等級（《野生動物保育法》I／II／III 級、文資法珍貴稀有植物），
   類群篩選只改變畫面上的卡片，送給模型的在地觀察清單固定為全部類群
3. **基地條件與棲地需求** — OSM 自動偵測環境特徵；Sentinel-2 NDVI（10 m）算出 500 m、1 km、5 km、10 km
   四個半徑的植生覆蓋與景觀結構（見下節）；棲地需求為獨立結構化欄位
4. **未來使用活動**（選填）— 遊憩、自然體驗、療癒與社區、常見高衝擊四類膠囊（最多 10 項）+ 自訂輸入 + 預期使用規模；
   有選擇時，報告增加第 5 節「人類活動影響與使用建議」（活動影響表與活動 × 分區相容性矩陣），其後各節順延
5. **特別考量** — 自由文字
6. **執行分析** — 輸入通行碼即可分析，結果回到表單，可下載 HTML 或列印 PDF

---

## 來源查證與排除規則

報告完成後，工具自動以 DOI 註冊資料（doi.org、Crossref、DataCite）、書目資料庫（Crossref、OpenAlex）
與所列網頁逐筆查核參考文獻與「參考案例」表的每一列（`/api/verify`），並依下列資料原則過濾報告
（「資料沒有或不正確的就不要納入討論了，不然討論也是假的資訊」）：

- **刪除**：查無此來源、DOI／網址指向其他著作、題名與引用不符，或無法確認存在的來源，
  以及正文中引用它們的句子、表格內容與案例列（由 AI 改寫刪除，再以確定性規則把關；改寫失敗時只套用規則，並明確標示）。
- **保留**：書目相符；來源存在但無法自動比對內容（PDF、動態網頁）或僅卷期頁碼有出入；
  查證未完成、但網址出現在本次網路搜尋結果中；本工具提供的 iNaturalist／OSM 資料集。
- **更正後保留**：文獻存在但年份或作者有誤者，依 DOI 註冊資料或書目紀錄更正正文與清單。
- **引用句與來源摘要比對**（v1.35）：查證與排除之後，取得每個保留來源的摘要（OpenAlex、Crossref、Semantic Scholar，
  或出版頁面的 citation_abstract；沒有摘要的網頁取其內文），由語言模型逐句判斷引用它的句子是否得到摘要支持：
  摘要支持／部分支持／摘要未提及／與摘要不符。只標示、不刪除；與摘要不符的句子在正文加註，每一句的結果列在附錄。
  取不到摘要的來源（PDF、網站拒絕存取）列為未比對。
- **限制**：書目查證只確認來源存在與書目正確；摘要比對只依摘要或網頁內文，「摘要未提及」不代表原文沒有，仍須閱讀全文；
  查證服務未能查核的項目（逾時、斷線、時間上限）既不刪除也不視為通過，原樣保留並標示「⏳ 未完成查證」；
  其餘已有確定結果的來源照常排除，報告標示「部分過濾」並可重試（一筆結果都沒有時不刪除任何內容，標示「尚未過濾」）。

被排除的來源、原因與影響範圍列在報告附錄「已排除之資料來源」；排除前的版本暫存於本機歷史紀錄，僅供對照。

---

## 架構

```
瀏覽器 → /api/analyze（Netlify Edge Function，補上金鑰）→ Anthropic API
瀏覽器 → /api/verify（Netlify Edge Function）→ doi.org／Crossref／OpenAlex／所列網頁
瀏覽器 → /api/models（Netlify Edge Function）→ Anthropic Models API（可用模型清單，快取 6 小時）
瀏覽器 → /api/taxon-status（Netlify Edge Function）→ TaiCOL 臺灣物種名錄（保育類與特有種，含臺灣的亞種、變種；快取 24 小時）
瀏覽器 → /api/tbn（Netlify Function）→ TBN 臺灣生物多樣性網絡（逐類群取樣；快取 6 小時）
瀏覽器 → /api/ndvi（Netlify Function）→ Earth Search STAC → AWS 上的 Sentinel-2 L2A COG（Range 讀取；CDN 快取 1 天）
```

金鑰存於 Netlify 伺服器端環境變數，瀏覽器完全看不到。
Edge Function 採串流回應，因此不受標準 serverless function 逾時限制。

### 檔案結構

```
├── index.html                      單檔前端應用
├── netlify.toml                    部署設定與 Edge Function 路由
├── .gitignore                      排除 .env 等敏感檔
├── .env.example                    環境變數範本（不含真值）
├── SETUP.md                        部署與環境變數設定指南
├── GITHUB-SETUP.md                 從拖拉部署改為 GitHub 連動的步驟
└── netlify/
    ├── edge-functions/
    │   ├── analyze.js              Claude API 代理（金鑰在伺服器端；mode 'revise' 為不搜尋的排除改寫）
    │   ├── models.js               可用模型與建議模型（GET /api/models）
    │   ├── taxon-status.js         iNaturalist 卡片的保育類與特有種（代查 TaiCOL；POST /api/taxon-status）
    │   └── verify.js               參考文獻與案例來源查證（NDJSON 串流）
    ├── functions/
    │   ├── pdf-text.mjs            PDF 內文抽取（Node 執行環境；Edge 的 50 ms CPU 裝不下 pdf.js）
    │   ├── tbn.mjs                 TBN 物種紀錄逐類群取樣與彙整（GET/POST /api/tbn）
    │   └── ndvi.mjs                Sentinel-2 NDVI 中位數合成與四個半徑的景觀結構指標（GET /api/ndvi）
    └── shared/
        ├── model-catalog.js        模型目錄：各系列最新一版、單價、建議規則（analyze.js 與 models.js 共用）
        └── sse-relay.js            串流轉送：搜尋迴圈暫停時自動接續、keepalive、網頁全文不轉送
```

### 植生與景觀結構（Sentinel-2 NDVI，`/api/ndvi`）

選定基地點後，伺服器以 Earth Search（Element 84）的 STAC 服務找出近 12（或 24）個月、整景雲量 < 70% 的
Copernicus Sentinel-2 Level-2A 影像（Collection 1，10 m），分季各取雲量最低的景（最多 8 景），只讀以基地點為中心
20 km 見方視窗所需的 COG tile（紅光 B04、近紅外 B08，各約 9 個 tile；SCL 場景分類層 20 m），
以 SCL 遮掉雲、雲影、卷雲、雪與無資料，逐像元取 NDVI 的中位數，再算四個半徑（500 m、1 km、5 km、10 km）的：

- 綠度：NDVI 平均、中位數、第 10／90 百分位
- 組成：水域（NDVI < 0）、無植生或人工鋪面（0–0.2）、低植生（0.2–0.5）、密植生（≥ 0.5）的比例
- 景觀結構（密植生與全部植生各算一次；塊區（patch）為圓內 8 鄰接的連續像元）：塊區數、平均與最大塊區面積、
  最大塊區佔比、有效網目大小（effective mesh size，Jaeger 2000）、邊緣密度、塊區密度

面板顯示疊在底圖上的 NDVI 預覽圖與四個半徑圈、指標表、使用的景與雲量；數字連同門檻說明與使用方式寫進提示詞
（500 m／1 km 供分區與資源利用矩陣，5 km／10 km 供活動範圍大的物種與連結度），並附 APA 7 參考文獻。
查證把它認成本工具提供的資料集（與 iNaturalist／OSM／TBN 相同），附錄「資料來源」列出景數、期間、遮罩與門檻。

**誠實標示**：NDVI 量的是綠色生物量，不是棲地品質；農田、人工草坪也算植生，密植生不等於天然林；
門檻是通用值、不是在地校正的土地覆蓋分類；塊區是依門檻切出來的，不是土地覆蓋圖。這些話由 `/api/ndvi` 隨資料回傳（`notes`），
提示詞明確要求模型不可寫成「森林覆蓋率」或「棲地面積」。

為什麼是中位數而不是最大值：最大值合成偏向生長季、會撿到殘雲邊緣的異常值；中位數對殘雲與陰影穩健。
分季挑景是因為臺灣的無雲景集中在冬季乾季，不分季的話中位數會偏低。
第一次算一個基地約 10–20 秒；同一基地、同一個月的查詢由 Netlify CDN 快取接手（期間鍵取「本月 1 日往前 N 個月」），
全班五十人只算一次。影像經 HTTP Range 直接讀 AWS 上的公開 COG，不需金鑰。

### 分析模型（不寫死）

「分析模型」選單由伺服器向 Anthropic Models API 取得目前可用的模型，Opus／Sonnet／Haiku 各只列最新一版；
Anthropic 推出新版時自動跟上，舊版的偏好設定也會自動改用建議模型。

- **建議模型**：最新的 Sonnet。本工具的分析（網路搜尋＋長篇報告，每份約 3–8 分鐘）用 Sonnet 品質接近 Opus，
  速度較快、單價約為 Opus 的一半。選單會標示各模型相對於建議模型的費用倍數與每百萬 tokens 單價。
- **本機實測**：每份完成的報告在瀏覽器記錄耗時與 tokens，選單下方顯示該模型的平均分析時間與每份費用。
- **推理強度**：分析用 `high`（多查、查得仔細，減少「未查得」）、排除改寫用 `low`；Haiku 不支援此設定，不送出。
- **網路工具**：搜尋最多 15 次；Sonnet／Opus 另可讀取網頁全文最多 6 頁（論文、政府文件中的數值多半不在搜尋摘要裡），
  並使用可先篩選結果的新版工具。讀過的網頁算作本次取得的來源。Haiku 只搜尋。
- **自動接續**：伺服器端的搜尋迴圈每 10 輪會暫停（`pause_turn`），代理會自動接續（最多 4 次），報告不會因此中斷；
  長時間思考或讀取網頁時送出 keepalive，網頁全文不轉送給瀏覽器。
- **提示快取**（2026-11-05 起）：搜尋迴圈每一輪都把前面的提示詞、搜尋結果與網頁全文重讀一遍；分析的請求帶 `cache_control`，
  API 會在每次搜尋結果後面自動設快取點，重讀的部分改按快取價（Sonnet 5.5／Opus 5.5 為輸入單價的 0.05 倍、其他 0.1 倍，
  寫入 1.25 倍），自動接續也讀得到前一輪的快取。排除改寫與摘要比對各只送一次，不開。
  API 萬一不接受快取參數，代理會拿掉快取重送一次，分析照常完成。本機實測的費用照快取的計價算。
- **排除改寫**：一律用最新的 Sonnet（產生報告用 Haiku 時沿用 Haiku），不用較貴的模型。
  第一次改寫失敗或未完全依指示刪除時，自動重試一次（附上第一次的遺漏），採用較好的一次。
- **文獻查證重試**：查證服務未查核，或對方網站暫時性錯誤（逾時、連線失敗、5xx）的來源，逐筆再查一次（最多 8 筆）。
- 更高階的 Fable 系列單價約為 Opus 的 2.5 倍，不列入選單。
- 單價表在 `netlify/shared/model-catalog.js`（Models API 不提供價格）；未列出的新模型沿用同系列最新單價，並標示「估計」。

### 環境變數（在 Netlify Dashboard 設定，切勿寫入 repo）

| Key | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 金鑰 |
| `QI_PASSCODE` | 課程通行碼；未設定則分析不驗證（等同對外開放），查證與排除改寫則不提供 |
| `VERIFY_MAILTO`（選填） | Crossref／OpenAlex 的聯絡信箱，可提高文獻查證的查詢額度 |
| `RECOMMENDED_MODEL`（選填） | 指定建議模型（例如 `claude-opus-5-5`）；須是目前可用的模型，否則沿用預設（最新的 Sonnet） |

詳見 `SETUP.md`。

---

## HEALS 總控台串接

支援三狀態模式（獨立 / 上游基地可用 / 接續 Map），
可接收 map 站經跨子網域 cookie `heals_site` 或網址 `#site=` 傳來的基地範圍。
獨立使用為預設，偵測到上游資料時僅邀請、不自動套用。

匯出 JSON 供總控台「完成打卡」，含 `focalSpecies`、`habitatNeeds`、
`habitats`、`species`、`activities`（未來使用活動）、`useScale`（預期使用規模）等欄位供下游 zoning 站讀取。

---

## 外部資料來源

| 來源 | 用途 | 授權 |
|---|---|---|
| OpenStreetMap | 圖磚、Overpass 環境特徵、Nominatim 地名搜尋 | ODbL |
| iNaturalist | 在地物種觀察記錄、物種在臺灣的身分（特有／原生／外來） | CC BY-NC |
| TaiCOL 臺灣物種名錄 | 特有種與保育類等級（卡片標示） | CC BY 4.0 |
| TBN 臺灣生物多樣性網絡 | 物種出現紀錄（原生／外來、保育等級、紅皮書） | OGDL-1.0 及各資料集授權 |
| Copernicus Sentinel-2（ESA），經 Earth Search（Element 84） | NDVI 植生與景觀結構（10 m，近 12／24 個月中位數合成） | Copernicus 資料授權（免費開放；註明「含經修改之 Copernicus Sentinel 資料」） |
| Anthropic Claude | 分析生成 | — |

---

## 授權

CC BY-NC-SA 4.0 · 張俊彥（Chang Chun-Yen）
國立臺灣大學園藝暨景觀學系

建議引用格式：
> 張俊彥（2026）。棲共生 Qi-Coexistence v1.33：景觀生態共存設計工作流工具 [Web App]。國立臺灣大學園藝暨景觀學系。

---

## 免責聲明

本工具供研究、教學、設計參考使用。AI 生成之分析結果需經人工查證、
專業判斷與在地田野驗證。資料來源由社群貢獻，可能有缺漏或時效落差。

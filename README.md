# 棲共生 Qi-Coexistence v1.31

景觀生態共存設計工作流工具 · eco4design.healsdesign.org
國立臺灣大學 園藝暨景觀學系 · HEALS Design System

---

## 這是什麼

輸入基地位置與焦點物種，工具會自動蒐集在地生態資料（iNaturalist 物種觀察、
OpenStreetMap 環境特徵），再交由 Claude 生成完整的生態共存設計分析報告。

**使用者不需自備 API 金鑰**，只需輸入授課教師提供的通行碼。

---

## 六步驟工作流

1. **選擇基地位置** — 地圖點選、地名搜尋（Nominatim）、或輸入經緯度
2. **焦點物種** — iNaturalist 自動載入在地觀察 + 預設組合 + 自訂輸入
3. **基地條件與棲地需求** — OSM 自動偵測環境特徵；棲地需求為獨立結構化欄位
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
- **限制**：查證只確認來源存在與書目正確，不確認文中的數值或論述確實出自該來源；
  查證服務未能查核的項目（逾時、斷線、時間上限）既不刪除也不視為通過，原樣保留並標示「⏳ 未完成查證」；
  其餘已有確定結果的來源照常排除，報告標示「部分過濾」並可重試（一筆結果都沒有時不刪除任何內容，標示「尚未過濾」）。

被排除的來源、原因與影響範圍列在報告附錄「已排除之資料來源」；排除前的版本暫存於本機歷史紀錄，僅供對照。

---

## 架構

```
瀏覽器 → /api/analyze（Netlify Edge Function，補上金鑰）→ Anthropic API
瀏覽器 → /api/verify（Netlify Edge Function）→ doi.org／Crossref／OpenAlex／所列網頁
瀏覽器 → /api/models（Netlify Edge Function）→ Anthropic Models API（可用模型清單，快取 6 小時）
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
    │   └── verify.js               參考文獻與案例來源查證（NDJSON 串流）
    └── shared/
        └── model-catalog.js        模型目錄：各系列最新一版、單價、建議規則（analyze.js 與 models.js 共用）
```

### 分析模型（不寫死）

「分析模型」選單由伺服器向 Anthropic Models API 取得目前可用的模型，Opus／Sonnet／Haiku 各只列最新一版；
Anthropic 推出新版時自動跟上，舊版的偏好設定也會自動改用建議模型。

- **建議模型**：最新的 Sonnet。本工具的分析（網路搜尋＋長篇報告，每份約 3–8 分鐘）用 Sonnet 品質接近 Opus，
  速度較快、單價約為 Opus 的一半。選單會標示各模型相對於建議模型的費用倍數與每百萬 tokens 單價。
- **本機實測**：每份完成的報告在瀏覽器記錄耗時與 tokens，選單下方顯示該模型的平均分析時間與每份費用。
- **推理強度**：分析用 `medium`、排除改寫用 `low`（兼顧品質、時間與 token）；Haiku 不支援此設定，不送出。
- **排除改寫**：一律用最新的 Sonnet（產生報告用 Haiku 時沿用 Haiku），不用較貴的模型。
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
| iNaturalist | 在地物種觀察記錄 | CC BY-NC |
| Anthropic Claude | 分析生成 | — |

---

## 授權

CC BY-NC-SA 4.0 · 張俊彥（Chang Chun-Yen）
國立臺灣大學園藝暨景觀學系

建議引用格式：
> 張俊彥（2026）。棲共生 Qi-Coexistence v1.31：景觀生態共存設計工作流工具 [Web App]。國立臺灣大學園藝暨景觀學系。

---

## 免責聲明

本工具供研究、教學、設計參考使用。AI 生成之分析結果需經人工查證、
專業判斷與在地田野驗證。資料來源由社群貢獻，可能有缺漏或時效落差。

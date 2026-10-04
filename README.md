# 棲共生 Qi-Coexistence v1.31

景觀生態共存設計工作流工具 · eco4design.healsdesign.org
國立臺灣大學 園藝暨景觀學系 · HEALS Design System

---

## 這是什麼

輸入基地位置與焦點物種，工具會自動蒐集在地生態資料（iNaturalist 物種觀察、
OpenStreetMap 環境特徵），再交由 Claude 生成完整的生態共存設計分析報告。

**使用者不需自備 API 金鑰**，只需輸入授課教師提供的通行碼。

---

## 五步驟工作流

1. **選擇基地位置** — 地圖點選、地名搜尋（Nominatim）、或輸入經緯度
2. **焦點物種** — iNaturalist 自動載入在地觀察 + 預設組合 + 自訂輸入
3. **基地條件與棲地需求** — OSM 自動偵測環境特徵；棲地需求為獨立結構化欄位
4. **特別考量** — 自由文字
5. **執行分析** — 輸入通行碼即可分析，結果回到表單，可下載 HTML 或列印 PDF

---

## 架構

```
瀏覽器 → /api/analyze（Netlify Edge Function，補上金鑰）→ Anthropic API
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
└── netlify/edge-functions/
        └── analyze.js              Claude API 代理（金鑰在伺服器端）
```

### 環境變數（在 Netlify Dashboard 設定，切勿寫入 repo）

| Key | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic 金鑰 |
| `QI_PASSCODE` | 課程通行碼；未設定則不驗證，等同對外開放 |

詳見 `SETUP.md`。

---

## HEALS 總控台串接

支援三狀態模式（獨立 / 上游基地可用 / 接續 Map），
可接收 map 站經跨子網域 cookie `heals_site` 或網址 `#site=` 傳來的基地範圍。
獨立使用為預設，偵測到上游資料時僅邀請、不自動套用。

匯出 JSON 供總控台「完成打卡」，含 `focalSpecies`、`habitatNeeds`、
`habitats`、`species` 等欄位供下游 zoning 站讀取。

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

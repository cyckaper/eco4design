# 棲共生 Qi-Coexistence v1.21（eco4design.healsdesign.org）

景觀生態共存設計工作流工具 · 新增 HEALS 總控台串接（純增量）

## v1.21 新增：接收上游基地範圍 + 生態結果匯出

### 串接模式（有 site 時）
- 自動讀取 map 寫入的跨子網域 cookie `heals_site`（domain=.healsdesign.org）或網址 `#site=<enc>` hash
- payload：`{ v:1, boundary:[[lat,lng],…], center:[lat,lng], locationName:"", area:<公頃,選填> }`
- 在地圖上把 boundary 畫成分析範圍並 fitBounds
- 依範圍自動挑夠大的 iNat/OSM 查詢半徑、以 center 餵入既有單點查詢引擎（自動載入物種與環境）
- 換位 [lat,lng]→[lng,lat] 產生封閉環 GeoJSON 存於 state（供匯出）
- 預填地點名稱、顯示可關閉橫幅「已接收上游基地範圍 · <locationName>　[改用手動]」
- 來自 `#site=` 時套用後清掉 hash（cookie 保留）

### 獨立模式（無 site／解析失敗）
- 100% 維持現狀，既有手繪／搜尋流程完全不變
- 任何串接環節失敗一律靜默退回獨立模式，載入絕不丟例外

### 生態結果匯出（給總控台打卡）
- 歷史區新增「📤 匯出生態結果（打卡）」：輸出開放 schema JSON，含 hub 認得的英文 key：
  `focalSpecies / interactions / zones / speciesProfiles / resourceAllocation / habitatNeeds`
  另含 `siteConditions / locationName / center / boundary / geojson / analysisHtml`
- 匯出同時複製到剪貼簿，方便直接貼進總控台
- 注意：分析產出走這條 JSON，不塞進 `heals_site`

## 設計原則
純增量。所有改動外加，不改變既有獨立操作流程與 UI；不引外部套件。

---
NTU 園藝暨景觀學系 · HEALS Design System · v1.21

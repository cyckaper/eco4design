# 從拖拉部署改為 GitHub 連動 · 完整步驟

適用：eco4design.healsdesign.org（棲共生 v1.28）
預估時間：15–20 分鐘

---

## 🚨 開始前必讀的兩件事

**第一：不要建立新的 Netlify site。**
你現在的 site 已綁定 `eco4design.healsdesign.org` 網域，並存有環境變數。
要在**既有 site 上連結 repo**，不是重新建立。建新 site 會讓網域、環境變數、
以及 healsdesign.org 的子網域設定全部要重來。

**第二：金鑰永遠不進 repo。**
`ANTHROPIC_API_KEY` 只存在 Netlify Dashboard 的環境變數。
一旦提交到 GitHub（即使 private、即使馬上刪掉），git 歷史仍保留，
且可能被自動掃描偵測並撤銷。若不慎提交，唯一正解是到 Console 撤銷金鑰、重新產生。

---

## Part 1 · 準備檔案（Mac）

1. 下載 `qi-coexistence-netlify.zip` 並解壓縮
2. 確認資料夾內有這些檔案：

```
index.html
netlify.toml
README.md
SETUP.md
.gitignore          ← 隱藏檔
.env.example        ← 隱藏檔
netlify/
  └── edge-functions/
        └── analyze.js
```

3. **重要**：`.gitignore` 與 `.env.example` 以點開頭，Finder 預設不顯示。
   在 Finder 視窗按 **Cmd + Shift + .**（句點）即可顯示／隱藏這類檔案。

---

## Part 2 · 建立 GitHub repo

1. 前往 https://github.com/new
2. 填寫：
   - **Repository name**：例如 `eco4design`
   - **Public / Private**：兩者皆可（程式碼不含祕密）。
     Public 適合學術公開；在意曝光就選 Private。
   - **不要**勾選 "Add a README file"（我們自己有 README.md，勾了會衝突）
3. 按 **Create repository**

---

## Part 3 · 上傳檔案

在新 repo 頁面點 **uploading an existing file**（或 Add file → Upload files）。

**方法一：整批拖拉（較快）**
把 Part 1 那些檔案 **連同 `netlify` 資料夾**一起拖進上傳區。
GitHub 網頁版支援拖曳資料夾，會自動保留 `netlify/edge-functions/` 的層級。

> 若拖曳後發現 `.gitignore`、`.env.example` 沒被上傳，
> 表示 Finder 沒顯示隱藏檔，請回到 Part 1 第 3 點開啟顯示後重拖。

**方法二：手動建立巢狀檔案（最穩，適合 iPad）**
若拖曳資料夾失敗，可用「Add file → Create new file」，
在檔名欄輸入完整路徑：

```
netlify/edge-functions/analyze.js
```

輸入 `/` 時 GitHub 會自動建立資料夾層級。再把 `analyze.js` 的內容貼進去即可。
`.gitignore` 與 `.env.example` 也可用同樣方式手動建立。

最後在下方 Commit 訊息填 `Initial commit: 棲共生 v1.28`，按 **Commit changes**。

---

## Part 4 · 把既有 Netlify site 連結到 repo

**這一步是關鍵，請務必在既有 site 上操作，不要按 "Add new project"。**

1. Netlify Dashboard → 點進 **eco4design** 這個 site
2. 左側 **Site configuration**（或 Project configuration）
3. 進入 **Build & deploy** → **Continuous deployment**
4. 在 **Repository** 區塊按 **Link repository**
5. 選擇 **GitHub** → 授權 Netlify GitHub App
   - 授權範圍建議選 **Only select repositories**，只勾剛建立的 repo，權限最小化
6. 選擇你的 repo，分支選 **main**
7. 設定 Build settings：

| 欄位 | 填入 |
|---|---|
| Base directory | 留空 |
| Build command | **留空** |
| Publish directory | **`.`**（一個半形句點）|
| Functions directory | 留空（Netlify 自動偵測 `netlify/edge-functions/`）|

> ⚠️ Publish directory 必須指向 `index.html` 實際所在位置。
> 因為 index.html 在 repo 根目錄，所以填 `.`。
> 這裡填錯會出現「部署成功但頁面 404 或是舊版」——這正是你上次 Netlify Forms 註冊失敗的原因。

8. 按 **Deploy site**

---

## Part 5 · 確認環境變數仍在

環境變數屬於 site 層級，連結 repo 不會清除，但請確認：

1. **Site configuration → Environment variables**
2. 應看到 `ANTHROPIC_API_KEY` 與 `QI_PASSCODE`
3. 若不見了就重新新增
4. 新增或修改後，到 **Deploys → Trigger deploy → Clear cache and deploy site**

---

## Part 6 · 驗收

| 檢查項目 | 預期結果 |
|---|---|
| Deploys 頁面 | 最新一筆來源顯示 GitHub commit（非 "Manual deploy"）|
| 開啟網站（Cmd+Shift+R）| 頁首版號顯示 **v1.28** |
| Site configuration → Edge Functions | 出現 `analyze` |
| 實際測試 | 輸入通行碼 → 選位置與物種 → 按「開始分析」→ 正常串流出結果 |
| 檢視原始碼（Cmd+U）搜尋 `sk-ant` | **找不到**（金鑰在伺服器端）|

---

## Part 7 · 之後的日常更新流程

1. 我給你新版 `index.html`（或其他檔案）
2. GitHub repo 頁面 → 點進要取代的檔案 → 右上鉛筆圖示，或直接把新檔拖進 repo 根目錄覆蓋
3. 下方填 commit 訊息（例如 `v1.29: 修正 xxx`）→ **Commit changes**
4. Netlify 自動偵測並部署，約 30–60 秒
5. **Cmd + Shift + R** 強制重新整理，確認頁首版號已更新

比拖拉部署多了版本紀錄：每次改動都有 commit 歷史，出問題可回溯，
在 Deploys 頁面也能一鍵 **Publish deploy** 回到任一舊版本。

---

## 疑難排解

| 現象 | 原因與處理 |
|---|---|
| 部署後頁面 404 | Publish directory 填錯，應為 `.` |
| 頁面是舊版 | 瀏覽器快取，Cmd+Shift+R；或確認 commit 真的推上去了 |
| Edge Functions 沒出現 `analyze` | `netlify/edge-functions/analyze.js` 路徑不對，或 `netlify.toml` 沒上傳 |
| 分析回「伺服器尚未設定 API 金鑰」 | 環境變數遺失或未重新部署 |
| Netlify 沒自動部署 | Continuous deployment 的分支設定不是 `main` |

---

NTU 園藝暨景觀學系 · HEALS Design System

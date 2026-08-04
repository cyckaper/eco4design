# 棲共生 v1.28 · 部署與設定指南（伺服器端金鑰版）

## 這版改了什麼

使用者**不再需要自備 API 金鑰**，只要輸入你發給的**通行碼**即可使用。
金鑰存在 Netlify 伺服器端的環境變數，瀏覽器完全看不到（檢視原始碼、F12 都看不到）。

架構：瀏覽器 → 本站 `/api/analyze`（Edge Function，補上金鑰）→ Anthropic API

---

## ⚠️ 部署前必做：設定環境變數

**沒設定環境變數，分析功能不會運作。**

1. Netlify Dashboard → 你的 site → **Site configuration** → **Environment variables**
2. 新增兩個變數：

| Key | Value | 說明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | 你的 Anthropic 金鑰 |
| `QI_PASSCODE` | 自訂通行碼 | 發給學生用，例如 `ntu2026eco` |

3. 存檔後**重新部署一次**（環境變數要重新部署才會生效）

> 若沒設 `QI_PASSCODE`，通行碼檢查會停用 = **任何人都能用你的帳戶**。務必設定。

---

## 🛡️ 三道防線（請全部設定）

### 1. 通行碼（門鎖）— 已內建
唯一能區分「你的學生」與「路過機器人」的機制，且不受校園 NAT 影響。
換通行碼只要改環境變數再重新部署即可。

### 2. Anthropic Console 花費上限（煞車）— **請自行設定**
Console → Settings → Limits → 設定每月上限。
這是最後保險：即使通行碼外流，損失有天花板。

### 3. 模型選擇（省錢）
預設已改為 **Claude Sonnet 4.6**（品質足夠、速度快、費用約 Opus 的 1/5、較少遇到 529 壅塞）。

---

## 關於 IP 速率限制（為何沒做）

原本考慮加「同 IP 每小時 N 次」，但**校園網路通常做 NAT，50 個學生對外可能是同一個 IP**。
這會導致：設太嚴 → 全班共用額度、課堂卡死；設太寬 → 對攻擊者無效（換 IP 很容易）。

因此改以**通行碼為主要控管** + **Console 花費上限為硬性後盾**。
Edge Function 另有內建防護：只允許三個指定模型、提示詞長度上限 24,000 字元。

---

## 部署方式

### 方式 A · 拖拉部署
拖拉部署時，**必須包含 `netlify/edge-functions/` 資料夾**（zip 已含）。
Edge Function 跑在 Deno 上，不需要 build 步驟或 npm install。

### 方式 B · GitHub 連動部署（建議）

架構完全不用改，Edge Function 就是 repo 裡的一個檔案，Netlify 會自動偵測。

**🚨 唯一紅線：金鑰永遠不可進入 repo。**

環境變數只設在 Netlify Dashboard，**不要**寫進任何被提交的檔案。
GitHub 有自動掃描機制，Anthropic 金鑰一旦被提交（即使是 private repo、即使幾分鐘後刪掉），
都可能被偵測並自動撤銷；而且**刪 commit 沒用，git 歷史仍保留**。
若不慎提交，唯一正解是立刻到 Console 撤銷該金鑰並重新產生一把。

repo 應有的結構：

```
your-repo/
├── index.html
├── netlify.toml
├── .gitignore          ← 已附，排除 .env
├── .env.example        ← 範本，不含真值，可安全提交
├── README.md
├── SETUP.md
└── netlify/
    └── edge-functions/
        └── analyze.js
```

**Netlify 端設定**（Site configuration → Build & deploy）：

| 項目 | 值 |
|---|---|
| Build command | 留空 |
| Publish directory | `.`（repo 根目錄，因為 index.html 在根目錄）|

> ⚠️ Publish directory 必須對應 `index.html` 實際所在位置。
> 若之後把檔案移到 `public/`，這裡也要一起改成 `public`，
> 否則會出現「部署成功但頁面是舊的／404」這類難查的問題。

環境變數仍在 **Site configuration → Environment variables** 設定
（同前述 `ANTHROPIC_API_KEY`、`QI_PASSCODE`）。
改動環境變數後要 **Trigger deploy → Clear cache and deploy site** 才會生效。

**日常更新流程**：GitHub 上拖檔覆蓋 → commit → Netlify 自動部署 → Cmd+Shift+R 驗證頁首版號。

**Public 還是 Private repo？**
程式碼本身不含任何祕密，設 public 沒有安全問題（適合學術公開）。
但 public repo 會讓網址與通行碼機制被更多人看到；若在意就設 private。
無論哪種，「金鑰不進 repo」這條規則都不變。

**本機開發（選用）**：`netlify dev` 會讀取 `.env`；
複製 `.env.example` 成 `.env` 填入真值即可，`.gitignore` 已排除它。

部署後檢查：
1. 頁首版號應顯示 **v1.28**
2. Netlify Dashboard → Edge Functions 應看到 `analyze`

---

## 給學生的說明範本

> 網址：https://eco4design.healsdesign.org
> 通行碼：（你設定的 QI_PASSCODE）
>
> 第一次使用請在「5 執行分析與結果」的通行碼欄位輸入通行碼，勾選「記住通行碼」即可。
> 不需要申請任何 API 金鑰。

---

## 疑難排解

| 現象 | 原因與處理 |
|---|---|
| 「伺服器尚未設定 API 金鑰」 | 環境變數沒設或沒重新部署 |
| 「通行碼不正確」 | 檢查大小寫、前後空白；確認 `QI_PASSCODE` 值 |
| 429 錯誤 | 同時使用人數多，等 1–5 分鐘 |
| 529 錯誤 | Anthropic 端壅塞，非本站問題，稍後重試 |
| 分析中途斷線 | 網路不穩；重新按「開始分析」 |

若要停止服務：直接刪除 `ANTHROPIC_API_KEY` 環境變數並重新部署。

---
NTU 園藝暨景觀學系 · HEALS Design System · v1.28

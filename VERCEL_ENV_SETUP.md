# 童軍支部版部署及功能變數

## 1. Google Sheet / Apps Script

1. 建立 Google Sheet。
2. 開啟「擴充功能 → Apps Script」，貼上本專案的 `apps-script/Code.gs`。
3. 執行 `initializeSheets()` 一次並授權。
4. 「部署 → 新增部署 → 網頁應用程式」：執行身分選「我」、誰可存取選「所有人」。
5. 複製 `/exec` URL，填入 `data/troops.json` 的 `backend`。
6. 在 `Users` 工作表以 `squad` 欄填寫小隊名稱，例如：紅隊、藍隊；在 `成員名單` 工作表以 `小隊` 欄填寫同樣名稱。
7. SHEEP 維護登入：帳號 `sheep`、密碼 `0728`。此帳號由後端直接處理，不會出現在 Users 清單。

## 2. Vercel

本 APP 是靜態前端，Google Sheet URL 可以公開放在 `data/troops.json`；真正的資料權限由 Apps Script token、角色及審批流程保護。

建議在 Vercel Project Settings → Environment Variables 設定：

| 名稱 | 用途 | 建議值 |
|---|---|---|
| `SCOUT_SHEET_URL` | 童軍支部 Apps Script `/exec` URL | 你部署後的 URL |
| `SCOUT_ADMIN_API` | 旅團接入申請管理 Apps Script URL | 管理員 API URL |
| `SCOUT_TROOP_ID` | 預設旅團 | `0082` |
| `SCOUT_APP_NAME` | APP 名稱 | `童軍支部進度及行政平台` |

注意：因為 Vercel 靜態頁面不能在瀏覽器直接讀取 server-side Environment Variables，現有前端仍會使用 `data/troops.json` 作為旅團設定來源。若要完全由環境變數注入，需改用 Vercel Serverless API 代理；不要把系統管理密碼或 Google Sheet 私密金鑰放入前端環境變數。

部署後測試：

- `/`：登入頁
- `/?u=0082`：預選第 82 旅
- 領袖登入後：全團總覽 → 小隊篩選
- 成員提交完成紀錄後：審批中心 → 批准
- 表格列印：可選成員及直出興趣章清單

## 小隊職務

在 Users 填寫 `squad` 及 `squad_role`。`squad_role` 可填 `隊長`、`副隊長` 或 `member`。

## 主系統接入（Portal / iframe）

本 APP 保留主系統接入能力。主系統可用 iframe 或連結帶入以下參數：

```text
/?u=0082&role=member&ymis=1234567890&name=成員姓名&from=portal&embed=1&backend=APPS_SCRIPT_EXEC_URL&apikey=API_KEY&troopName=第82旅
```

參數說明：

- `u`：旅團編號
- `role`：主系統已驗證的角色
- `ymis`：登入者 YMIS
- `name`：顯示姓名
- `from=portal`：啟用主系統免登入模式
- `embed=1`：隱藏獨立登入及頁尾，適合 iframe
- `backend`：該旅團 Apps Script `/exec`
- `apikey`：該旅團後端 API Key
- `troopName`：旅團名稱

主系統負責身份驗證，童軍支部 APP 負責訓練進度、審批、徽章及表格功能。若不傳入 `backend`，APP 會從 `data/troops.json` 按 `u` 查找旅團設定。

注意：主系統不應把 SHEEP 密碼放入 URL；Portal 只傳入已驗證身份及短期使用連結。正式部署建議由主系統後端產生帶身份的短期 token，並限制 iframe 的來源網域。

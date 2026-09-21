# 新旅團接入流程

## A. 建立新旅團（僅新 Sheet）

1. 建立 Google Sheet，開啟 Apps Script，貼上 `apps-script/Code.gs`。
2. 只在這個全新的 Sheet 執行一次 `initializeSheets()` 並完成授權。
3. 部署為 Web App，取得既有部署的 `/exec` URL 與 API Key。

> 已投入使用的 Sheet 不要為本次 Vercel／驗證升級執行初始化。更新程式後部署既有 Web App 的新版本即可，原 `/exec` URL 不變。

## B. Vercel 旅團登記

在 Project Settings → Environment Variables 加入以下三項；旅團編號直接寫在變數名稱中：

```text
TROOP_0082_NAME=第 82 旅
TROOP_0082_BACKEND=https://script.google.com/macros/s/你的部署ID/exec
TROOP_0082_APIKEY=Apps Script 既有 API Key
```

如旅團編號是 `0015`，三項名稱就是 `TROOP_0015_NAME`、`TROOP_0015_BACKEND`、`TROOP_0015_APIKEY`。三項缺一不會被登記；編號按原字串處理，所以 `0082` 與 `82` 不會互相取代。

後端 URL 與 API Key 僅由 Vercel 函式使用，不能放進前端程式、靜態 JSON、網址參數或 Git。重新部署後，首頁會從 `/api/troops` 取得只含編號與名稱的清單。

## C. 回歸檢查

1. 首頁只顯示已完整設定的旅團卡片。
2. 選取旅團後，以既有一般成員及領袖帳號登入。
3. 驗證讀取、進度寫入、帳戶申請與審批仍指向該旅團的既有資料。
4. 確認跨旅團切換後，先前登入狀態不會被重用。

## D. MOCK 測試

MOCK 資料保留在 `data/mock_members.json` 與相關範例檔；只寫入瀏覽器快取，不會直接寫入正式 Sheet。

## E. 主系統 Portal

Portal 卡片可使用不帶後端憑證的連結，例如：

```text
/?u=0082&ymis=1234567890&role=member&from=portal&embed=1
```

連結會選取已登記的旅團並帶入嵌入模式；網址中的身分與角色只可作登入表單預填，不能建立 session 或授權。正式免登入整合必須使用主系統後端簽發、可驗證且短效的票據；不可把 URL／來源／角色參數當作身份驗證。

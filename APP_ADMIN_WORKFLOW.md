# APP 管理工作流程

一個 Vercel Project 可以安全地服務多個旅團，而每個旅團保有自己的 Apps Script deployment、Sheet 與資料。

## 新旅團資料

管理員收到以下資料後，在 Vercel Project 的受保護 Environment Variables 登記：

- 旅團編號（保留前導零）
- 顯示名稱
- 既有 Apps Script `/exec` URL
- 既有 Apps Script API Key

每個旅團正好使用 `TROOP_{ID}_NAME`、`TROOP_{ID}_BACKEND`、`TROOP_{ID}_APIKEY` 三個變數。不要提交這些值到 Git、靜態設定檔、前端或 URL。

## 操作步驟

1. 在 Vercel 設定三個完整變數。
2. 重新部署同一個 Project。
3. 確認 `/api/troops` 僅顯示編號及名稱。
4. 用該旅團既有帳號進行讀寫、審批和跨旅團隔離測試。

`0082` 與 `82` 是不同旅團識別字；不要以別名、補零或共用設定來混合它們。

## Portal

保留 `PORTAL_DEFAULT_ORIGIN`、`PORTAL_DEFAULT_ROLES` 與各旅團的 Portal 覆蓋設定。這些設定只控制整合範圍；URL 或角色參數不是可靠的身份驗證，不能代替伺服器授權。

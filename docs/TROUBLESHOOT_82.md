# 旅團連線排查

## 旅團沒有出現在首頁

在 Vercel 檢查同一個編號的三個變數是否都存在且非空：

```text
TROOP_0082_NAME
TROOP_0082_BACKEND
TROOP_0082_APIKEY
```

後端必須是有效的 `https://script.google.com/.../exec` URL。重新部署後開啟 `/api/troops`；回應應只包含編號與名稱。系統不會將 `82` 補為 `0082`，兩者須各自正確登記。

## 後端服務沒有回應

確認既有 Apps Script Web App 的 `/exec` URL、部署存取權及 Apps Script 授權狀態。使用 Apps Script 編輯器的 `diagnoseSheets()` 只讀檢查既有工作表狀態。

不要為本次代理或登入升級而執行 `initializeSheets()`、`repairSheets()`、清空資料或變更工作表欄位。若需修復真正缺失的工作表，先備份並依既有營運流程處理。

## Portal

Portal 連結只應傳遞旅團選擇與嵌入資訊，例如 `/?u=0082&from=portal&embed=1`。不要把 Apps Script URL、API Key 或身份驗證資料放在網址中；來源與角色參數不是身份驗證。

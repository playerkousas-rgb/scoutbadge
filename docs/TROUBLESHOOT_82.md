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

## 中央登入（sheep）失敗

中央帳號 `sheep` 嘅密碼係 Vercel 嘅 `SUPER_KEY`，唔再存喺 Sheet。失敗時登入頁／
「測試連線」會直接講係邊一關：

| 訊息 | 原因 | 處理 |
|---|---|---|
| 中央登入尚未設定（Vercel 環境變數 `SUPER_KEY` 未設定或太短） | Vercel 未設 `SUPER_KEY`（至少 4 字元） | 設定 `SUPER_KEY` 後重新部署 |
| 中央登入尚未設定：請先由領袖登入 →「成員管理 → 中央登入設定」 | 該旅團 Apps Script 未做一次性 verifier 設定 | 以領袖（團長或以上）登入 →「成員管理 → 中央登入設定」→ 儲存 → 測試連線 |
| Vercel 登記嘅後端網址同本 Sheet 嘅 Web App 網址唔一致 | `TROOP_{ID}_BACKEND` 同 Sheet 嘅 `/exec` 網址唔同（多咗斜線／空格，或係舊部署 ID） | 修正 `TROOP_{ID}_BACKEND` → 重新部署 → 再撳一次「儲存設定」重新計雜湊 |
| Vercel 未登記旅團編號 | `TROOP_{ID}_NAME／_BACKEND／_APIKEY` 唔齊，或編號同變數名唔一致 | 補齊三個變數（`0082` 同 `82` 唔互通） |
| 中央登入驗證端點連唔到／回應異常 | 端點唔係公開 https、被重新導向，或 Vercel 未重新部署 | 端點填 `https://<本部署域名>/api/verify-super-ticket`；改動後重新部署 |
| 旅團後端尚未更新（缺少中央登入 `superLogin`） | Sheet 上嘅 Apps Script 係舊版 | 覆寫 `apps-script/Code.gs`，喺原有 Web App 部署新版本（保留 `/exec` URL） |
| 登入嘗試次數過多，請稍後再試 | 密碼錯 5 次，鎖 15 分鐘（**只計密碼錯**，設定問題唔會鎖） | 等 15 分鐘；順便確認 `SUPER_KEY` |

補充：

- 帳號大小寫同前後空白唔影響（`Sheep`、` sheep `、`sheep@scoutbadge.local` 都可以）。
- `SUPER_KEY` 前後有多餘空白／換行（Vercel 貼上常見）而家會自動 trim，唔會再變成長期登入失敗。
- 「測試連線」而家係真自我檢查：會話你知旅團有冇登記、後端網址雜湊一唔一致，
  唔會再淨係睇 HTTP status 就報成功。
- 一次性設定要**先有領袖登入到**；新旅團請先用領袖帳號登入做設定。

## Portal

Portal 連結只應傳遞旅團選擇與嵌入資訊，例如 `/?u=0082&from=portal&embed=1`。不要把 Apps Script URL、API Key 或身份驗證資料放在網址中；來源與角色參數不是身份驗證。

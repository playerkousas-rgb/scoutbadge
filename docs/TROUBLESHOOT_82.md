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

## 更新 Code.gs 之後一定要「部署新版本」

喺 Apps Script 編輯器覆寫 `Code.gs` **唔會**改變 `/exec` 提供嘅程式：Web App 行嘅係
你**部署嗰個版本**。每次改完 `Code.gs`：

1. Apps Script 編輯器 → 右上角「部署」→「管理部署作業」。
2. 揀既有嗰個 Web App 部署 → 鉛筆（編輯）→「版本：建立新版本」→ 部署。
3. `/exec` URL 會保持不變 —— 所以要保留舊 URL，一定要用「管理部署作業」而唔係「新增部署」。

見到「中央登入尚未設定，自動開通又失敗」或者「旅團後端尚未更新（缺少中央登入
`superLogin`）」，九成係呢一步未做。

> 唔使、亦唔應該為咗呢啲改動而執行 `initializeSheets()`／`repairSheets()`：
> 佢哋會改既有工作表，對已經有資料嘅旅團有風險。

## 中央登入（sheep）失敗

中央帳號 `sheep` 嘅密碼係 Vercel 嘅 `SUPER_KEY`，唔再存喺 Sheet。失敗時登入頁／
「測試連線」會直接講係邊一關：

| 訊息 | 原因 | 處理 |
|---|---|---|
| 中央登入尚未設定（Vercel 環境變數 `SUPER_KEY` 未設定或太短） | Vercel 未設 `SUPER_KEY`（至少 4 字元） | 設定 `SUPER_KEY` 後重新部署 |
| 中央登入尚未設定：請先由領袖登入 →「成員管理 → 中央登入設定」 | 該旅團 Apps Script 未設定驗證端點，**而自動開通又失敗**（多數係後端仲係舊版） | 覆寫 `apps-script/Code.gs`，喺原有 Web App 部署新版本；正常情況 Proxy 會自動開通，唔使預先有領袖 session |
| 中央登入尚未設定，自動開通又失敗：請去「部署 → 管理部署作業」建立新版本 | 後端識得中央登入合約，但仲未部署到支援自動開通嗰個版本；**或者部署咗 #23 修復前嘅版本**（`hmacHex` 簽名參數次序錯，自動開通嘅簽名兩邊永遠對唔上，同樣必敗） | 部署 → 管理部署作業 → 為既有 Web App「建立新版本」（見下面）；若 Code.gs 係 #23 之前嘅版本，要再覆寫一次最新 `apps-script/Code.gs` 然後建立新版本 |
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
- **唔使再預先做一次性領袖設定**：只要 `SUPER_KEY` 啱，Proxy 會喺登入時自動幫嗰個旅團
  開通驗證端點（用本團 apikey 簽嘅 5 分鐘短效許可；瀏覽器冇 apikey，偽造唔到），
  所以新旅團都唔會再出現「要有領袖先開到中央登入」嘅雞生蛋。
- **#23 修復**：之前 GAS 端 `hmacHex` 誤用 `computeHmacSha256('SHA_256', msg, key)`
  （真實 API 係 `computeHmacSha256Signature(value, key)`），真正嘅 key 被當第三參數丟棄，
  Vercel 簽嘅開通許可永遠驗唔到，自動開通 100% 失敗。已改為正確呼叫，
  並喺 `test/central_login.test.js` 加咗「兩邊簽名互通」回歸測試；
  測試用嘅 GAS 模擬器亦改用真實 API 名稱同參數次序，唔可以再靜靜雞夾啱。
- 「成員管理 → 中央登入設定」仍然保留：用嚟手動設定、或檢查後端網址一唔一致。
- 如果部署網址推斷唔到（例如自訂網域、前面仲有 proxy），可以設
  `SCOUTBADGE_VERIFY_URL=https://你的域名/api/verify-super-ticket`。

## Portal

Portal 連結只應傳遞旅團選擇與嵌入資訊，例如 `/?u=0082&from=portal&embed=1`。不要把 Apps Script URL、API Key 或身份驗證資料放在網址中；來源與角色參數不是身份驗證。

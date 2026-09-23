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

見到「旅團後端仍未支援中央登入回打驗票」或者「中央登入驗票失敗：…」，九成係呢一步未做
（覆寫 `Code.gs` 之後一定要為既有 Web App 建立新版本）。

> 唔使、亦唔應該為咗呢啲改動而執行 `initializeSheets()`／`repairSheets()`：
> 佢哋會改既有工作表，對已經有資料嘅旅團有風險。

## 中央登入（sheep）失敗

中央帳號 `sheep` 嘅密碼係 Vercel 嘅 `SUPER_KEY`，唔再存喺 Sheet。

流程係「**Vercel 封票 → GAS 回打固定端點驗票**」：Vercel 核對 `SUPER_KEY` 之後封一張
1 分鐘短效票（唔會送密碼去後端），GAS 收到之後用 `UrlFetchApp` 回打
`SUPER_VERIFY_URL`（`apps-script/Code.gs` 常數，預設 `https://<本部署域名>/api/verify-super-ticket`）
驗票，驗過先發 session。**本團 `API_KEY` 單獨係開唔到中央 session 嘅**（舊版單向授權已停用）。

失敗時登入頁／「測試連線」會直接講係邊一關：

| 訊息 | 原因 | 處理 |
|---|---|---|
| 中央登入尚未設定（Vercel 環境變數 `SUPER_KEY` 未設定或太短） | Vercel 未設 `SUPER_KEY`（至少 4 字元） | 設定 `SUPER_KEY` 後重新部署 |
| 旅團後端仍未支援中央登入回打驗票（舊版單向授權已停用）…建立新版本 | Sheet 上嘅 Apps Script 係舊版（唔識回打驗票） | 覆寫 `apps-script/Code.gs` →「部署 → 管理部署作業」→ 為既有 Web App「建立新版本」（保留 `/exec` URL） |
| 中央登入驗票失敗：連唔到端點…（請確認 Code.gs 嘅 `SUPER_VERIFY_URL` 常數…） | ① 首次未授權 `script.external_request`；② 常數域名同實際部署唔同（自架／自訂域名／換過域名）；③ Vercel 未部署或出事 | ① 見下方「Apps Script 外部請求權限設定」；② 改 `Code.gs` 嘅 `SUPER_VERIFY_URL` 一行 → 建立新版本；③ 開 `/api/troops` 睇 Vercel 在唔在生 |
| 中央登入驗票失敗：驗票端點回應 HTTP 5xx | Vercel 部署未完成或有錯 | 去 Vercel 睇 deployment log 再 redeploy |
| Vercel 登記嘅後端網址同本 Sheet 嘅 Web App 網址唔一致 | `TROOP_{ID}_BACKEND` 同 Sheet 嘅 `/exec` 網址唔同（多咗斜線／空格，或係舊部署 ID） | 修正 `TROOP_{ID}_BACKEND` → 重新部署 → 再按一次「測試連線」 |
| Vercel 未登記旅團編號 | `TROOP_{ID}_NAME／_BACKEND／_APIKEY` 唔齊，或編號同變數名唔一致 | 補齊三個變數（`0082` 同 `82` 唔互通） |
| 本機 API Key 唔等於 Vercel 嘅 `TROOP_{編號}_APIKEY` | Sheet 嘅 `API_KEY`（選單「🔑 顯示 BACKEND／APIKEY」睇到）同 Vercel 登記唔同 | 兩邊對齊（改 Vercel 變數後重新部署） |
| 登入失敗（無其他說明） | 票唔啱：過期（>1 分鐘）、已用過、或唔係本部署封嘅票 | 重新登入一次；如果持續發生，先做「測試連線」 |
| 登入嘗試次數過多，請稍後再試 | 密碼錯 5 次，鎖 15 分鐘（**只計密碼錯**，設定問題唔會鎖） | 等 15 分鐘；順便確認 `SUPER_KEY` |
| 中央登入連線失敗：`UrlFetchApp.fetch` 缺少 `script.external_request` 權限 | **首次**使用回打驗票時，Apps Script 需要授權 `script.external_request` 才能對外發送 HTTP 請求 | 見下方「Apps Script 外部請求權限設定」 |
| 線上驗票端點已經係 Code.gs 常數… | 有人喺「中央登入設定」按「儲存設定」，填咗 https 網址 | 唔需要設定：線上端點寫死喺 `Code.gs` 常數；自架／自訂域名就改嗰一行。本地測試才用 `127.0.0.1`／`localhost` |

補充：

- **Apps Script 外部請求權限設定（一次性，必須人手批）**：
  回打驗票係腳本**第一次**需要對外發送請求——`verifyCentralTicket()`／`testTrustedTicketVerifier()` 要用 `UrlFetchApp.fetch` 打返 Vercel 驗票。Apps Script 對「對外請求」有獨立權限 `script.external_request`，之前從未使用過，所以需要**人手授權一次**：
  
  1. 在 Apps Script 編輯器頂部函數下拉選單選 `testTrustedTicketVerifier` → 按「執行」
  2. 彈出授權對話框：「檢閱權限」→ 選 Google 帳號
  3. Google 會警告「未驗證應用」→ 按「進階」→「前往〈專案名〉(不安全)」→「允許」
  4. 再執行一次 `testTrustedTicketVerifier`，應該見到「旅團已登記、後端一致，中央登入回打驗票可用」
  
  如果執行時**完全沒彈授權框、立即彈同一個錯**：即專案的 `appsscript.json` manifest 用了明確 `oauthScopes`。需要：
  
  1. 左邊「專案設定」→ 打開「在編輯器中顯示 appsscript.json 資訊清單檔」
  2. 在 `oauthScopes` 陣列加一行：`"https://www.googleapis.com/auth/script.external_request"`
  3. 儲存 → 返去執行 `testTrustedTicketVerifier` → 這次會彈授權框 → 允許
  4. 然後「部署 → 管理部署作業」→ 為既有 Web App「建立新版本」
  
  批完權限後，Web App 的授權會跟著更新（部署是「以我的身分執行」），`sheep` 登入就正常，不需再改 code。
  
  > 這是 Google Apps Script 的安全機制，無法用程式繞過，但只需做一次。

- 帳號大小寫同前後空白唔影響（`Sheep`、` sheep `、`sheep@scoutbadge.local` 都可以）。
- `SUPER_KEY` 前後有多餘空白／換行（Vercel 貼上常見）而家會自動 trim，唔會再變成長期登入失敗。
- 「測試連線」係真自我檢查：`GET` 端點要回 **405**（只收 POST，證明端點在生），再用本機
  API Key ＋ 本機 `/exec` 網址做 probe，回報 `troop_known`／`key_ok`／`backend_matches`。
  三個都 true 才代表中央登入可用。
- **同一張票只可以用一次**（GAS `CacheService` 記 120 秒，票壽命 60 秒）：所以「上一頁」
  再送出、或者兩邊同時開會失敗一次，係預期行為，重新登入即可。
- **唔會回退單向授權**：驗票端點連唔到時係 fail closed（503），唔會偷偷用 `API_KEY` 放行。
  想暫時救急，唯一正路係修好端點／授權，或者由管理員喺 Apps Script 直接用 Sheet。
- **唔使再預先做一次性領袖設定**：以前嘅「自動開通（bootstrap）」機制已經完全移除；
  端點係常數，冇雞生蛋問題。
- 「成員管理 → 中央登入設定」保留，但**只做本地 loopback 覆寫同測試連線**；
  線上唔需要、亦唔可以設定端點。

## Portal

Portal 連結只應傳遞旅團選擇與嵌入資訊，例如 `/?u=0082&from=portal&embed=1`。不要把 Apps Script URL、API Key 或身份驗證資料放在網址中；來源與角色參數不是身份驗證。

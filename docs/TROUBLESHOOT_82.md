# 旅團連線排查

## 旅團沒有出現在首頁

在 Vercel 檢查同一個編號的三個變數是否都存在且非空：

```text
TROOP_0082_NAME
TROOP_0082_BACKEND
TROOP_0082_APIKEY
```

後端必須是有效的 `https://script.google.com/.../exec` URL。重新部署後開啟 `/api/troops`；回應應只包含編號與名稱。系統不會將 `82` 補為 `0082`，兩者須各自正確登記。

## 剛登記完，唔知用咩帳號第一次登入

全新旅團部署完成後，Sheet 入面只有一個 `initializeSheets()` 自動建立嘅**預設管理員**：

- 揀該旅團卡片 → 「👤 成員」分頁（用 YMIS 登入，唔好用「領袖＝Email」分頁）
- YMIS：`1111111111`　密碼：`changeme`
- 登入後系統會即時強制改密碼（至少 4 位），改完先入到 App

之後用呢個帳號審批申請／開戶，再開返各領袖自己真 YMIS 嘅帳號。完整步驟見
`TROOP_ONBOARDING.md` §C「首次登入（預設管理員帳號）」。

出「找不到此帳號」即係該 Sheet 從未跑過 `initializeSheets()`（見 §A），或者 `Users` 表
第 2 行預設管理員被人手刪咗；出「密碼錯誤」通常係已經有人登入改過密碼——搵改過嘅人攞新密碼，
或者用中央 `sheep` 登入重設。呢個帳號係**旅團管理員（admin）**，同中央帳號 `sheep`
（密碼存 Vercel `SUPER_KEY`）係兩回事。

## 後端服務沒有回應

確認既有 Apps Script Web App 的 `/exec` URL、部署存取權及 Apps Script 授權狀態。使用 Apps Script 編輯器的 `diagnoseSheets()` 只讀檢查既有工作表狀態。

**出「旅團後端要求 Google 登入，伺服器無法匿名存取」／「後端服務暫時無法使用」（尤其係其他旅團正常、只有新團失敗）**：
即係 `/exec` 冇行到 `Code.gs`，而係回咗 Google 登入頁——用無痕窗口直接開條 `/exec` 網址，
彈登入頁就係中招。成因多數係用**學校 Google Workspace 帳戶**部署後端：

1. 「部署 → 管理部署作業 → 編輯」確認存取權係**「任何人」**，唔係「〈學校域名〉內任何人」
   或「任何擁有 Google 帳戶的人」，執行身分係「我」；改完一定要**建立新版本**先生效；
2. 「任何人」選項唔存在／揀完仍然強制登入 → 學校 Workspace 管理員政策封咗對外發佈，
   改用非學校 Google 帳戶部署（做法見 `TROOP_ONBOARDING.md` §A）；
3. `TROOP_<編號>_BACKEND` 要同 **Google「部署 → 管理部署」視窗提供嘅部署網址**逐字一致，包括
   `/a/macros/<學校域名>/` 前綴（如有）——proxy 呼叫時會自動轉成標準 `/macros/` 形式，唔使人手改，
   改咗反而會令後端雜湊核對唔上。GS 選單「🔑 顯示 API KEY（交 ADMIN）」只提供 API Key，
   唔會顯示、推算或快取任何部署網址。

不要為本次代理或登入升級而執行 `initializeSheets()`、`repairSheets()`、清空資料或變更工作表欄位。若需修復真正缺失的工作表，先備份並依既有營運流程處理。

## 登入回「後端服務連線逾時，請稍後再試」（超管入得、一般帳號入唔到）

2026-11-04 旅團 **1187** 回報：中央超管 `sheep` 入得，「第 1 個帳號」（預設管理員
`1111111111`）登入就一直回「後端服務連線逾時，請稍後再試」。**唔係 API Key 問題**，
唔需要改 `TROOP_1187_APIKEY`。

### 一分鐘分辨「唔係 API Key」

1. **超管入得，就證明 Key／URL／部署存取權全部正常**：中央登入同密碼登入都經
   `/api/proxy` 用同一組 `TROOP_<編號>_BACKEND`＋`_APIKEY` 打同一個 `/exec`。
   中央登入封票時 proxy 一樣會用該團 API Key（`createSuperTicket`），後端一樣要
   `getApiKey()` 對得上才受理。Key 錯的話中央登入會即刻失敗，唔會入得。
2. **Key 錯係「快錯」，唔係「逾時」**：Key 唔對時 `Code.gs` 的 `requireAuthBody()`
   即刻回 403（前端顯示「未授權：缺少 API Key 或有效簽名」），1–2 秒內就有答案；
   永遠唔會變成 25 秒後的「連線逾時」。
3. **Vercel log 一行就分得清**（Vercel → 專案 → Logs → 搵 `troop=1187`）：
   - `[proxy] upstream_timeout troop=1187 action=login limit=45000ms duration=…`＝**後端太慢**（今次情況）；
   - `[proxy] troop=1187 action=login status=200 duration=120ms success=false`＝後端有答，只係 Key／帳密問題。

### 真正成因：後端密碼核對太慢，撞爆 25 秒上游上限

GS `6.2.0`／`6.3.0` 把密碼雜湊改成 `PBKDF2-HMAC-SHA256` **120,000 次迭代**。Apps Script
每次 `Utilities.computeHmacSha256Signature()` 都要過一次 JS↔Java 邊界（約 0.1–0.3 ms，
唔係 Node 嗰種幾微秒），所以：

| 情況 | KDF 成本（GS 6.2.0／6.3.0） | 25 秒上限下 |
|---|---|---|
| 密碼正確（`pbkdf2$120000$` 帳號） | 驗證 1× ＋「是否預設密碼」再 1×＝**2×＝240,000 次（24–40 秒）** | 必定逾時 |
| 停用／不存在／鎖定帳號（反枚舉） | dummy KDF 1–2×＝120,000–240,000 次 | 多數逾時 |
| 舊 64-hex 帳號首次登入 | 驗證快，但要即場升級＝**1×＝120,000 次（12–20 秒）** | 剛好在邊界，勉強入得 |
| **中央超管 `sheep`** | **零 KDF**（只驗短效票） | 正常入得 |

所以典型症狀係「**超管一定入得，但密碼登入慢到（或慢過）25 秒**」；因為 1× 同 2× 剛好
跨越 25 秒上限，通常只有部分帳號出事——詳見下一節。同 Key 完全無關。

### 為什麼「之前其他舊帳」冇人報？三個原因（同一個 bug，但成本唔同）

最重要一點：**唔同帳號走唔同數量嘅 PBKDF2**，而 25 秒上限就係分界線，所以症狀會
「一團入面有啲入得、有啲唔得」，亦解釋咗為何舊帳普遍冇人出聲。

| 登入路徑 | GS 6.2.0／6.3.0 的 KDF 成本 | 25 秒上限下 |
|---|---|---|
| 舊 64-hex 帳號（GS 6.1.0 前建立、之後未登入過） | 驗證快，但要**即場升級**＝1× 120,000 | 約 12–20 秒，**勉強入得**（慢但成功） |
| 新開帳號／`initializeSheets()` 種的預設管理員／領袖重設過密碼的帳號（已係 `pbkdf2$120000$`） | 驗證 1× ＋「是否預設密碼」再 1×＝**2× 120,000** | 約 24–40 秒，**必定逾時** |
| 停用／已刪除／連續錯密鎖定／舊版保留 `super_admin` 列 | 反枚舉 dummy KDF 1–2× | 約 12–40 秒，**多數逾時**（所以連「已鎖定 15 分鐘」都顯示唔到，只見「連線逾時」） |
| 中央 `sheep` | 0（只驗短效票） | 正常 |

再配合以下兩點，就明白為何只有零星投訴：

1. **只有「已經貼咗 6.2.0／6.3.0」嘅旅團會中**（2026-11-02 至 11-04 之間貼新版嘅團）。
   其他團仍跑 6.1.0 或更舊 → 單次 SHA-256，登入 < 1 秒，完全正常。
2. **Apps Script 冷啟動、多人同時登入、Sheet 較大都會再加幾秒**，令同一條 1× 路徑由
   「20 秒入得」變成「26 秒逾時」——所以會出現「琴日得、今日唔得」、「有時得、有時唔得」。

1187 的「第 1 個預計帳號」正正係**預設管理員**：若 `initializeSheets()` 係喺 6.2.0／6.3.0
跑，`Users` 表第 2 列的 `password_hash` 就係 `pbkdf2$120000$`，即上表第 2 行（2× 成本），
所以其他舊成員入得、佢就一定入唔到。

### 30 秒驗證（唔需要改任何設定）

1. **本團**：部署 6.4.0 後在 Apps Script 執行 `benchmarkPasswordKdf()`（或選單「⏱️ 密碼雜湊效能測試」）。
   輸出會直接列出「舊 64-hex 帳號＝1× 幾秒」「新種帳號＝2× 幾秒」，同 25 秒上限對照。
2. **其他旅團（最快）**：Vercel → Logs 直接用 keyword `slow_password_kdf` 搜。GS 6.4.0 起
   proxy 對超過 8 秒的 `login`／`changePassword`／`resetPassword` 會額外輸出
   `[proxy] slow_password_kdf troop=<編號> action=login duration=…ms`，一行就認出邊個團仲未更新。
   亦可篩 `action=login` 睇 `duration`：幾百 ms ＝ 仍係舊 GS（未受害）；8–24 秒 ＝ 已貼
   6.2.0／6.3.0，隨時會爆（尤其新開／停用帳號）；25000ms ＋ `upstream_timeout` ＝ 已中招。
   另外，只要該團仍然回報 GS 6.2.x／6.3.x，登入頁、首頁及主畫面的「最新更新公告」會直接標紅
   「🔴 此版本登入會逾時」，唔需要逐個問。
3. 個別旅團版本：開 `https://script.google.com/macros/s/<部署ID>/exec?action=ecStatus`，
   回 `gsVersion` / `initializedGsVersion`。低於 `6.2.0` 就未受影響。

> 結論：同一個 bug，但「舊雜湊 1× 剛好入得、新雜湊 2× 必定逾時」＋「只有貼過新版的團」＋
> 「冷啟動令 1× 都有機會超線」，三者加起來就係「其他舊帳冇反應」的原因，唔代表 1187 特別壞。

### 處理（GS 6.4.0，2026-11-04）

1. 覆寫 `apps-script/Code.gs` →「部署 → 管理部署作業 → ✏️」→ **建立新版本**（保留同一條 `/exec`）。
2. Sheet 選單「🔗 旅系統 → 🔧 初始化／更新」按一次（只補缺失工作表／版本標記，不刪資料）。
3. 選單「🔗 旅系統 → ⏱️ 密碼雜湊效能測試」核實：本版格式應該幾秒內完成；
   如仍見到「舊 120,000 次 > 25 秒」，即係本團仍有舊雜湊帳號（見下）。

GS 6.4.0 的改動：

- 新雜湊改為 `pbkdf2$10000$…`（每戶隨機 16-byte 鹽不變）；驗證一律用雜湊自帶的迭代次數，
  所以**舊 `pbkdf2$120000$` 及更舊的 64-hex 照樣登入得**，唔會鎖死任何人。
- 舊雜湊帳號登入成功一次後**自動改寫**為本版格式，之後登入即回復 1–3 秒。
- 成功登入唔再額外做一次「是否預設密碼」的 PBKDF2（改為直接比較輸入密碼），成本由 240,000 次降到 10,000 次。
- Vercel proxy 對**密碼類 action**（`login`／`changePassword`／`resetPassword`／`setPw` 等）
  的上游逾時放寬到 **45 秒**（一般 action 仍 25 秒），令舊雜湊帳號「第一次」慢登入有機會完成；
  前端登入等 50 秒。正常（新雜湊）登入不受影響。

### 已經卡住的帳號怎麼辦（兩個做法，任揀一個）

- **直接登入一次**：部署 6.4.0 後，該帳號登入（最多等 40 秒）成功即可，之後自動變快。
- **唔想等 → Sheet 救援重設**（唔需要登入 App）：Sheet 選單「🔗 旅系統 → 🔑 重設某帳號密碼（救援）」，
  輸入 YMIS ／電郵＋新密碼（至少 4 位）。此動作只改 `Users.password_hash` 及
  `force_change_password`，同時清錯密鎖定、踢走該帳號舊 session；用戶下次登入會強制改密。

### 唔好做嘅事

- 唔好改 `TROOP_1187_APIKEY`／重發 API Key：同呢個症狀無關，改完只會令登記失效。
- 唔好叫用戶「再試幾次」：每次重試都再排一次 40 秒的 KDF，只會更塞（Apps Script 同時執行數有限）。
- 唔好為此跑 `repairSheets()`／清空資料／改工作表欄位。

### 6.2.0／6.3.0 之前的雜湊（參考）

- 64-hex SHA-256（GS 6.1.0 及之前）：單次雜湊，驗證 < 1 秒，但**無鹽**，所以升級是必要的。
- `pbkdf2$120000$`（GS 6.2.0／6.3.0）：安全但 Apps Script 做不完；6.4.0 起不再寫入。
- `pbkdf2$10000$`（GS 6.4.0）：10,000 次 × 每戶隨機鹽，配合 5 次錯密鎖 15 分鐘及反枚舉 dummy KDF。
  迭代次數係「Apps Script 每次呼叫都好貴」之下嘅取捨，已在 `apps-script/CHANGELOG.md` 記錄。

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
| 本機 API Key 唔等於 Vercel 嘅 `TROOP_{編號}_APIKEY` | Sheet 嘅 `API_KEY`（選單「🔑 顯示 API KEY（交 ADMIN）」睇到）同 Vercel 登記唔同 | 兩邊對齊（改 Vercel 變數後重新部署） |
| 登入失敗（無其他說明） | 票唔啱：過期（>1 分鐘）、已用過、或唔係本部署封嘅票 | 重新登入一次；如果持續發生，先做「測試連線」 |
| 登入嘗試次數過多，請稍後再試 | 密碼錯 5 次，鎖 15 分鐘（**只計密碼錯**，設定問題唔會鎖） | 等 15 分鐘；順便確認 `SUPER_KEY` |
| 中央登入連線失敗：`UrlFetchApp.fetch` 缺少 `script.external_request` 權限 | **首次**使用回打驗票時，Apps Script 需要授權 `script.external_request` 才能對外發送 HTTP 請求 | 見下方「Apps Script 外部請求權限設定」 |
| 線上驗票端點已經係 Code.gs 常數… | 有人喺「中央登入設定」按「儲存設定」，填咗 https 網址 | 唔需要設定：線上端點寫死喺 `Code.gs` 常數；自架／自訂域名就改嗰一行。本地測試才用 `127.0.0.1`／`localhost` |

補充：

- **次序**（兩種情境，唔好混淆）：
  1. **新開旅團**＝**GS 先、Vercel 後**：Sheet＋`Code.gs` → 執行一次 `initializeSheets()` → 部署 Web App
     取得 `/exec` URL 及 API Key → 才填 Vercel 嘅 `TROOP_<編號>_NAME／_BACKEND／_APIKEY` → Redeploy。
     （未部署 Web App 係冇 URL、未初始化係冇 KEY，所以呢個次序係天生嘅，唔係額外規矩。）
  2. **升級已登記旅團**＝**Vercel 先、葉端後**：先部署 Vercel 新 proxy，再到該團「建立新版本」。
     掉轉做（葉端先）唔會壞資料、唔影響成員登入，只係中央登入會回乾「登入失敗」，直到 Vercel 部署為止。
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

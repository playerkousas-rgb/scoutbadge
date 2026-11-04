# Apps Script 維護紀錄

版號、歷史更新及開發背景集中保留在 Git，不放入可下載的 GS 或用戶提示。
本文件不納入網站部署：`build.js` 只發布本目錄的 `Code.gs`，`.vercelignore` 亦排除其餘檔案。

## 2026-11-04：密碼 KDF 成本修正（登入 504 逾時）、KDF 效能測試、Sheet 救援重設（GS 6.4.0）

- **問題（旅團 1187 事故）**：GS 6.2.0／6.3.0 的 `PBKDF2-HMAC-SHA256 120,000` 次迭代，
  在 Apps Script 上要 20–40 秒（`Utilities.computeHmacSha256Signature()` 每次都要過
  JS↔Java 邊界，約 0.1–0.3 ms），超過 Vercel proxy 的 25 秒上游上限，令**所有密碼登入**
  回「後端服務連線逾時，請稍後再試」。中央 `sheep` 登入只驗短效票、免密碼核對，所以
  出現「超管入得、一般帳號入唔到」；與 API Key 完全無關（Key 錯會 1–2 秒回 403，不會逾時）。
- **`PBKDF2_ITERATIONS` 120,000 → 10,000**：新雜湊格式為 `pbkdf2$10000$<salt>$<dk>`
  （每戶 16-byte 隨機鹽不變）。驗證一律使用雜湊字串自帶的迭代次數，`PBKDF2_MIN_ITERATIONS`
  = 1,000、`PBKDF2_MAX_ITERATIONS` = 2,000,000，所以舊 `pbkdf2$120000$` 及舊 64-hex
  SHA-256 **照樣登入得**，不會鎖死既有帳號；超出範圍的迭代次數直接拒絕（防止被改大拖死一次執行）。
- **登入成本由 240,000 次降到 10,000 次**：`handleLogin()` 不再為「密碼是否仍是預設值」額外
  跑一次 PBKDF2——成功驗證後直接比較輸入密碼與 `ADMIN_PASS`（等價，因為同一密碼已驗證過
  stored hash）；`isDefaultPasswordHash_()` 只保留零成本的 64-hex 比對。
- **舊雜湊透明改寫**：新增 `storedHashIterations_()`／`passwordHashNeedsRehash_()`；舊 64-hex
  及舊 `pbkdf2$120000$` 帳號成功登入一次後自動改寫為本版格式（原密碼不變，本版格式不再重寫）。
- **反枚舉 dummy 雜湊快取**：`dummyPasswordHash_()` 改用 `CacheService`（6 小時）重用，
  令「帳號不存在／錯密碼」只做一次 KDF（原本每個執行都要重新計一次）。
- **新增 `benchmarkPasswordKdf()`** ＋ Sheet 選單「⏱️ 密碼雜湊效能測試」：即場量度
  120,000 次與本版迭代次數的實際毫秒數，並換算成四條登入路徑（舊 64-hex 1×／新種或已升級
  `pbkdf2$120000$` 2×／停用・不存在・鎖定 dummy 1–2×）各自要幾秒，用嚟解釋
  「同一團為何只有部分帳號入唔到」，以及判斷「登入逾時」係唔係 KDF 造成。
- **新增 `forceResetUserPasswordFromSheet()`** ＋ Sheet 選單「🔑 重設某帳號密碼（救援）」：
  擁有 Sheet 的管理員**不需要登入 App** 就可以把某帳號改寫成本版雜湊，同時清 `LOGIN_FAIL:<ymis>`
  鎖定、`destroyUserTokens()` 踢走舊 session、設 `force_change_password=true`；只改第 5 欄及第 16 欄，
  不刪列、不改其他資料，並寫入 `操作紀錄`（`sheet_reset_password`）。拒絕未知帳號、短於 4 位的新密碼
  及舊版殘留 `super_admin` 列。
- **`assets/batch-onboard/Code.gs` 同步改為 10,000 次**，兩邊雜湊（`pbkdf2$<iter>$…`）仍然互通。
- **Vercel 端配套**（`api/proxy.js`）：密碼類 action（`login`／`changePassword`／`resetPassword`／
  `setPw`／`verifyPw`／`confirmPasswordReset`／`addUser`／`bulkAddUsers`／`importUsers`／`importAll`／
  `upsertUser`）上游逾時 25 → 45 秒，一般 action 維持 25 秒；`index.html` 登入請求等 50 秒。
  只為「舊雜湊第一次登入」留一次機會，新雜湊登入仍舊 1–3 秒。
- **版本與資料保全**：`GS_VERSION` = `6.4.0`、`GS_RELEASE_DATE` = `2026-11-04`、
  `GS_INIT_REQUIRED` = `true`（與前端 `GS_LATEST` 同步）。回退方法：切回 6.3.0 `Code.gs`
  只會令所有密碼登入重新變慢／逾時，資料不受影響（已改寫成 `pbkdf2$10000$` 的帳號在 6.3.0 讀不到，
  要由領袖重設一次密碼，或用「🔑 重設某帳號密碼（救援）」）。
- **測試**：新增 `test/password-kdf.test.js`（迭代次數預算、舊 `pbkdf2$120000$`／64-hex 仍可驗證、
  登入一次自動改寫、成功登入只做一個 KDF、Sheet 救援重設、proxy 逾時預算及前端 timeout），
  已納入 `npm test`；`test/auth-hardening.test.js`、`test/troop_link.test.js`、
  `test/troop_upgrade.test.js` 及 `test/release-version.test.js` 改為由原始碼讀出迭代次數與版本，
  不再硬編碼 120,000／6.3.0。

## 2026-11-03：單一更新入口、正規化 /exec 雜湊、未初始化提示（GS 6.3.0）

- **單一更新入口**：新增選單「🔗 旅系統 → 🔧 初始化／更新」（`menuInitializeSheets()`），內部只呼叫
  `initializeSheets()`。貼上新 `Code.gs` 後用戶只需按同一個掣一次即可完成更新，唔需要再搵／執行
  `repairSheets()`、`diagnoseSheets()` 等其他函式；`initializeSheets()` 維持冪等只增不刪
  （只補缺失工作表、缺失表頭欄及版本標記，不刪不覆寫、不更換既有 `API_KEY`）。
- **正規化 `/exec` 網址雜湊**：新增 `canonicalServiceUrl_()`，`verifyCentralTicket()`、
  `testTrustedTicketVerifier()`、`diagnoseCentralLogin()` 計 `backendHash` 前一律把
  `https://script.google.com/a/macros/<域名>/s/<id>/exec`（及 `/a/<域名>/macros/s/<id>/exec`）
  轉成標準 `/macros/s/<id>/exec`。Workspace 帳戶的部署唔再因為 `getUrl()` 同登記字串形式唔同而
  「登入失敗」；Vercel 端 `api/verify-super-ticket.js` 同步接受兩種形式（`lib/registry.canonicalBackendUrl`
  亦已支援兩種 `/a/` 寫法）。仍然逐字一致以外的其他部署一律拒絕。
- **未初始化提示**：`showApiKey()`／`showVercelEnv()`／`menuShowLinkCredentials()` 在
  `INITIALIZED_GS_VERSION` 為空（或落後於 `GS_VERSION`）時，會在最上方顯示
  「⚠️ 尚未完成初始化／更新（此 API Key 暫時未可用）」並指示先按一次「🔧 初始化／更新」。
  Key 仍然照樣顯示，但唔會再令人以為「抄到 Key 就完成」。
- **初始化彈窗**：標明今次版本、並說明呢個動作就係唯一嘅更新步驟（重跑只補缺失表／欄，不刪改資料、
  不換 Key）。
- **Vercel 端配套**：新旅團申請提交時，若匿名 probe 回報 `initRequired: true` 而
  `initializedGsVersion` 為空，即時以 422 拒絕並指示先初始化（舊版後端冇呢兩個欄位＝未知，照樣轉交）；
  前端公告／教學步驟改為「選單 → 初始化／更新」，並把「🔑 顯示 API KEY」標明為最後一步。
- **版本與資料保全**：`GS_VERSION` = `6.3.0`、`GS_RELEASE_DATE` = `2026-11-03`、`GS_INIT_REQUIRED` = `true`
  （與前端 `GS_LATEST` 同步）。回退方法：切回上一版 `Code.gs`（資料不受影響，因為本版只新增函式／選單項目
  及對話框文案，未改動任何儲存格式）。
- **測試**：`test/release-version.test.js` 新增單一入口、未初始化警告、`canonicalServiceUrl_`／
  `canonicalBackendUrl` 一致性；`test/central_login.test.js` 新增兩種 `/exec` 形式的 probe 與真票驗證；
  `test/proxy.test.js` 新增未初始化後端 422 拒絕（且唔會送去管理員信箱）。

## 2026-11-02：PBKDF2 密碼雜湊、登入鎖定、反枚舉、職級重設權限與領袖電郵重設（GS 6.2.0）

- **A3 密碼雜湊全面升級**：`hashPassword`／`hashPasswordV2` 及 `assets/batch-onboard/Code.gs` 改用 `PBKDF2-HMAC-SHA256`（`120,000` 次迭代＋每用戶獨立 16-byte 隨機鹽，儲存格式 `pbkdf2$<iter>$<salt>$<dk>`）。涵蓋申請批核、新增用戶、批量開戶、直插設密、自行改密、領袖重設及電郵重設所有寫密入口。
- **舊帳平滑升級與匯入相容**：`verifyPassword` 同時支援 `pbkdf2$...` 與舊版 64-hex 無鹽 SHA-256；舊帳首次成功登入時自動將 `Users.password_hash` 重算升級為 `PBKDF2-HMAC-SHA256`（原密碼不變）。`upsertUser`／`linkUpsertUser`／`importUsers`／`setPw`／`verifyPw` 同時接受新舊兩種雜湊格式並拒絕明文（匯入專用入口）。
- **A5 登入鎖定與改密踢舊 session**：同一帳號連續 5 次密碼錯誤即寫入 Script Properties `LOGIN_FAIL:<ymis>` 鎖定 15 分鐘，鎖定期內即使輸入正確密碼亦拒絕，並寫入 `操作紀錄` 的 `login_locked`；成功登入或重設密碼自動清零。用戶自行 `changePassword` 後保留當前 token，踢走該帳號所有其他舊裝置 session（`destroyUserTokensExcept`）。
- **A17 公開入口反枚舉**：未登入公開入口（`handleLogin`、`handleRequestPasswordReset`、`handleConfirmPasswordReset`）對帳號不存在、無電郵、預設管理員或密碼錯誤一律回傳完全一致訊息（如 `帳號或密碼錯誤` 或中性發信提示），並在帳號不存在／不可重設時執行 `dummyPasswordHash_()` 消除 KDF 時間差；領袖後台查詢（`getAllUsers`／`getMembers`／電郵唯一性檢查）維持正常顯示存在與否。
- **重設密碼權限階梯與強制善後**：`canManageUser` 與 `handleResetPassword` 在 handler 內部強制驗證已認證 `manager` 物件的角色（涵蓋本機 token 與上游 `sig` 入口，絕不單憑自報 `ymis` 反查提權）：只准較高職級重設較低職級（只有 `SUPER_ADMIN` 可重設 `ADMIN`；`ADMIN` 不可重設另一 `ADMIN`；同級不可互改；`member` 不可重設任何人；`super_admin` 保留帳號不可被重設）。重設成功後強制同步執行三件事：清除 `LOGIN_FAIL:<target>`、踢走目標帳號全部既有 session（不影響操作者 session）、設 `force_change_password = true`。
- **領袖電郵自助重設密碼（第 2 條路徑）**：新增 `requestPasswordReset`、`confirmPasswordReset` 公開 action 及 `testPasswordResetMail()` 授權輔助函式；新增 `密碼重設` 工作表（`reset_id`／`ymis`／`email`／`code_hash`／`created_ms`／`expires_ms`／`attempts`／`status`／`used_at`），未跑 `initializeSheets()` 時首次使用亦會自動補建空白表。8 位不分大小寫重設碼只存 SHA-256 雜湊、15 分鐘有效、最多錯 5 次即作廢、單次使用、每鍵 30 分鐘限 3 次及全團每小時上限 30 次、自動清理 24 小時前舊列。`ADMIN_EMAIL` 維持 `admin@example.com` 不可收信（第 3 條路徑維持回報 APP ADMIN 以 `SUPER_KEY` 重設）。
- **Proxy 白名單與欄位剝除**：`api/proxy.js` 新增明確 `PUBLIC_ACTIONS`＋`AUTH_ACTIONS` 白名單（未知 action 直接回 `400`），並在轉發 `requestPasswordReset`／`confirmPasswordReset` 前剝除任何 `token`、`role`、`on_behalf`、`sig` 等欄位。
- **版本與資料保全**：`GS_VERSION` = `6.2.0`、`GS_RELEASE_DATE` = `2026-11-02`、`GS_INIT_REQUIRED` = `true`（與前端 `GS_LATEST` 同步）；`initializeSheets()` 維持冪等只增不刪。回退方法：直接切回上一版 `Code.gs`（已升級為 `pbkdf2$` 的帳號如要回退至舊版 GS，需由領袖重設一次密碼；不回退 GS 而只回退前端則零影響）。

## 2026-10-24：接入資料只提供 API Key、新增系統介紹（GS 6.1.0）

- **接入顯示**：`initializeSheets()` 完成彈窗、`showApiKey()`、`showVercelEnv()`、`vercelEnvLines()`、
  選單「🔑 顯示 API KEY（交 ADMIN）」（`menuShowLinkCredentials`）一律只提供 `API Key = …`。
- **不再顯示／回傳自動取得或快取的部署網址**：移除 `initializeSheets()` 的 `ScriptApp.getService().getUrl()`
  取值及回傳值 `scriptUrl`；不再讀 `WEBAPP_URL` 等舊快取；不新增人手貼網址到 GS 的設定流程。
- **不要求先設定旅團編號**：初始化不提示輸入編號、不寫入 `TROOP_ID`／`TROOP_NAME`，亦不新增「設定旅團編號」選單。
  用戶流程：初始化生成／保留 API Key → 完成 Google 部署並在部署視窗取得 URL → 自行在原有 ADMIN FORM 填編號、名稱、URL、API Key。
- **保留童軍自己的內容**：預設管理員首次登入／改密碼提示、綱要、評核權限、既有資料及 API Key 全部不變。
- **相容函式**：新增 `verifyBackendUrl()`（固定回 `AUTO_BACKEND_URL_DISABLED`）及 `menuVerifyBackendUrl()`，
  讓未重新載入的舊選單不會再猜網址、發請求或聲稱「已核實」。
- **不改內部協定**：中央登入／回打驗票（`SUPER_VERIFY_URL`、`verifyCentralTicket()`、`SUPER_TOKEN_PREFIX`）
  及簽名 `sig` 完全沒有改動。
- `GS_VERSION` = `6.1.0`、`GS_RELEASE_DATE` = `2026-10-24`；`initializeSheets()` 可安全重跑，
  只補表／補設定，寫入 `INITIALIZED_GS_VERSION`，不刪改任何既有資料，不更換既有 API Key。
- 前端 `index.html`：新增「🌿 系統介紹」分頁及部署教學雙向入口（通用介紹圖 `assets/system-introduction-zh-hant.webp`，
  中英說明及安全邊界）；`showWelcomeTab()` 交叉連結會選中正確分頁；`applyStaticI18n()` 支援 `data-i18n-alt`；
  部署步驟文案改為「Google 部署視窗提供 URL、自己填 ADMIN FORM」；`GS_LATEST` 同步為 `2026-10-24`／`6.1.0`。
- 本地預覽伺服器 `server.js` 提供 `.webp` → `image/webp`。
- 測試：新增 `test/credential-display.test.js`、`test/system-intro.test.js`；更新 `test/troop_link.test.js`、
  `test/release-version.test.js`；`README.md`、`TROOP_ONBOARDING.md`、`docs/LEADER_GUIDE.md`、
  `APP_ADMIN_WORKFLOW.md`、`docs/BACKEND_URL_DIAGNOSIS.md` 同步。
- **注意**：本次只修改 repository，不代表各旅團的線上 Google Apps Script 部署已更新。

## 2026-10-23：最新版本公告、GS 初始化核對及資料保全

- 新增 `GS_VERSION`／`GS_RELEASE_DATE`／`GS_INIT_REQUIRED` 常數及 `gsVersionInfo_()`，供前端核對。
- `ecStatus`（GET，閂口前放行）回報 `gsVersion`、`initializedGsVersion`、`initRequired`；只回版本資訊，不含用戶資料。
- `handleLoad()` 回應新增 `gsVersion`、`gsReleaseDate`、`initRequired`、`initializedGsVersion`。
- `initializeSheets()` 最後一步才寫入 `INITIALIZED_GS_VERSION`（Script Properties），表示此版本初始化已完成。
- **資料保全**：`initializeSheets()` 不再自動刪除殘留 `super_admin` 列或 Tokens；不再逐列改寫既有帳號的 `force_change_password`（改為登入時判斷預設密碼）。表頭只補空白格（`setHeaderIfEmpty_`），不覆蓋既有欄名。殘留 `super_admin` 列在 `getUser`／`getUserByEmail`／`handleLogin` 讀取時略過（`isLegacySuperRow_`），不可作為登入身分。
- 前端 `index.html`：首頁、登入頁、登入後主頁新增最新版本公告（日期、GS 版本、下載、更新步驟、「重新檢查」按鈕）；三狀態分辨「GS 未更新」、「GS 已更新但未初始化」、「全部完成」（綠色「已核對」）。
- `api/proxy.js`：`ecStatus` 以 GET 轉發（與 `load` 同路徑）。
- `test/release-version.test.js`：前端與 GS 版本一致、ecStatus／load 回報、初始化前後資料快照對比、重複初始化安全、API Key 不變、殘留列保留。

## 2026-09-23：中央登入（A）改成回打驗票（對齊 VS／RS）

- **安全升級**：舊版「純單向授權」只憑本團 `API_KEY` ＋ `isSuperAdmin: true` 就叫 GS 發中央 session；
  即係任何持有 D（Sheet 選單睇得到、會交 ADMIN／截圖流傳）嘅人都開得到中央帳號。
  現在改成 VS／RS 同款：**Vercel 核對 `SUPER_KEY` → 封一張 1 分鐘短效票 → GS 回打固定端點驗票 → 驗過先發 token**。
  信任錨由「本團 API_KEY」改成「Vercel 嘅 `SUPER_KEY`」。
- GS 新增常數 `SUPER_VERIFY_URL`（預設本部署域名 + `/api/verify-super-ticket`，自架要改一行）、
  `verifyCentralTicket()`（回打＋單次使用）、`superVerifyUrl()`（**只准 loopback 覆寫**，防止有人把票連 API Key 送去自己部機）。
- `handleSuperLogin()` 改成只認票：冇票／爛票／過期／重放／錯後端／錯 KEY／錯身份 → 401；
  驗票端點連唔到 → 503 **fail closed**（唔會回退單向授權）。回應增加 `central:"callback"` 標記。
- 呢條鏈嘅回應永不包含密碼：Vercel 唔會把密碼送去後端，票內只有 `troopId`／`backendHash`／身份／到期時間。
- 同一張票只可換一次 token（`CacheService` 記 `sha256(ticket)` 120 秒 > 票壽命 60 秒）。
- 「測試連線」`testTrustedTicketVerifier()` 改成真探測：`GET` 端點要回 405，再用本機 API Key ＋ `/exec` 雜湊探測，
  回報 `troop_known`／`key_ok`／`backend_matches`（只回 booleans，唔回後端網址）。
- 舊「中央登入設定」`configureTrustedTicketVerifier` 收窄成本地 loopback 覆寫（線上端點係常數，改唔到）；
  **自動開通（bootstrap）機制整個移除**（`validCentralBootstrap`／`CENTRAL_BOOTSTRAP_MAX_TTL`／
  Vercel `SCOUTBADGE_VERIFY_URL` 全部唔再用），冇咗雞生蛋同簽名唔一致（#23）兩個失敗家族。
- 首次仍然要人手授權一次 `script.external_request`（Apps Script 對外請求權限），呢個係回打模式唯一一次性人手步驟。
- Vercel 側：`api/proxy.js` 改為封票＋唔再接受舊版單向旗標；`api/verify-super-ticket.js` 由票內 `troopId` 查 registry
  （葉端毋須任何設定）＋比對 `apikey`／`backendHash`／`loginId`＋body ≤ 8 KB＋每 IP 額度；
  `lib/super-auth.js` 票封套改用 `SUPER_KEY`（payload 帶 troop 身份）、TTL 60 秒；新增 `lib/verify-rate-limit.js`。
- 測試：`test/central_login.test.js` 10 → 12 項（真票換 token、單次使用、錯後端／錯 KEY／錯身份／改 byte 全拒、
  常數優先、端點連唔到 503 fail closed）；`test/e2e_http.test.js` 25 → 27 項（mock GAS 真回打）；
  `test/proxy.test.js` 加封票／未更新後端 409／端點 503 三組；`test/log_claims.test.js`／`test/troop_upgrade.test.js`／
  `test/troop_link.test.js` 中央登入段落改成「只認票、唔會回 `upstream_only`」。
- 規格／版號唯一記錄更新：`operations/TROOP_LINK_UPGRADE.md` 第 12 節（VS／RS 逐項對照、失敗模式、未做清單）。
- 前端 `index.html` 零改動（舊「中央登入設定」介面保留，顯示端點係常數嘅訊息；要清屬另一輪前端工作）。

## 2026-09-23：旅系統上下游接駁（旅 > 團 > 進度）

- 新增「旅系統：上下游接駁」及「旅系統：Sheet 選單」兩節：上游登記下游 `DOWNSTREAM_<id>_*`（只存 Script Properties）後，
  經 `sig`（`sigKey = HMAC-SHA256("scoutbadge-troop-sig-v1", 下游 SHEET KEY)`，`canonical = action\n ts\n nonce\n sha256(rawBody)`）讀寫下游；
  兩組簽名（query ＋ body）同時送，時窗 ±5 分鐘、nonce 一次性、body ≤ 900 KB、常數時間比較。
- 直接入口掣 `ALLOW_LOCAL_LOGIN`：未設定＝開啟（現有旅團零影響）；只有 `1/true/yes/on/open` 係開啟，其餘任何值＝閂口（fail closed）。
  閂口後本地入口一律拒（舊 Portal sig 亦拒），只收上游 `sig`；中央登入（`superLogin`）與舊入口掣
  `get/setDownstreamAccess` 例外放行。
- `sig` action 白名單：12 讀 ＋ 19 寫；`login`／`apply`／`logout`／`changePassword`／`updateConfig`／`requestLogRecord`／`cancelLogRequest`／`portalLogin` 永不接受。
- 開戶：`createAccountForDownstream`（上游開戶 → 讀回 hash → `sig` 打下游 `upsertUser`，兩邊同一 hash）；鏡像／匯入用嚴格的
  `linkUpsertUser`（只收 64 位 hex hash，明文密碼拒，冇帶 hash 保留原密碼，冪等）。
- 吐 JSON：`exportUsersJson()` 寫私人 Drive 檔 `scoutbadge-users-<yyyyMMdd-HHmmss>.json`（Drive 失敗 fallback 去 Logger）；
  匯入（`importUsersFromDrive()`）零失敗即自動把該檔移入 Drive 垃圾桶（可還原 30 天，操作紀錄只記檔案 ID），**有失敗筆數就保留檔案**；
  只寫 Drive／Logger，绝不寫入工作表；`importUsersFromText`／`importUsersFromDrive` 逐個直插 hash（上限 2000 筆）。
- 選單「🔗 旅系統」：匯出／匯入 JSON、本機接駁狀態、顯示 BACKEND＋APIKEY（交 ADMIN）、登記／移除下游、測試連線（sig）、
  為下游開戶（揀團）、下游及本機兩個直接入口掣。
- 舊有 ecportal 合約（`portalLogin`、`childId|sub|scope|exp` sig、`exportAll`／寬鬆 `upsertUser`、`setPw`／`verifyPw`／`setStatus`、
  `get/setDownstreamAccess`）全部保留，行為只在閂口後改變（本地入口拒）。
- 前端 `index.html`、`api/`、`lib/` 零改動；新增守護測試 `test/troop_link.test.js`（10 項，`npm run test:link`）。
- 規格／版號唯一記錄：`operations/TROOP_LINK_UPGRADE.md`（維運文件，只留 Git，不部署）。

## 2026-09-22：GS 瘦身（不變更業務邏輯）

- 主後端移除歷史版號、裝飾分隔線、重複中英文說明、已搬移程式的舊註解，以及僅重述程式碼的註解。
- 初始化完成提示移除過時的 `v5.2` 字樣；保留設定結果與操作資訊。
- 保留必要的身份驗證、私隱範圍、舊工作表相容性及資料一致性註解。
- 批量開戶 GS 移除與 [操作指南](../docs/BULK_ONBOARD.md) 重複的長篇用法及欄位說明，保留 `CONFIG` 設定提示。
- 保留備份資料的 `version: '1.0'`：這是資料格式欄位，不是展示版號。API、功能支援旗標、工作表結構及權限均不變。
- `apps-script/Code.gs`：126,031 → 112,126 bytes（減少 11.0%）。
- `assets/batch-onboard/Code.gs`：9,209 → 6,840 bytes（減少 25.7%）。

以上是未壓縮檔案體積差異，不是載入時間基準測試。GS 在 Google 端執行；清理註解主要減少下載、複製及維護負擔，不代表 Google Sheets 查詢會明顯加快。

現有旅團要套用瘦身檔案，仍須覆寫 Apps Script 並為既有 Web App 建立新部署版本，保持原 `/exec` URL。不需要執行 `initializeSheets()` 或 `repairSheets()`。

## 歷史版本摘要（由 GS 註解整理）

下列版號沿用原註解，並非本次發布的新版本；原註解未記錄各版發布日期。更完整的變更以 Git 歷史為準。

### v5.1 / v5.1.1

- 新增活動履歷，涵蓋服務、活動及訓練班紀錄（原註解參考 VSBADGE 設計）。
- `handleLoad` 提供活動履歷與 `logsSupported`，供前端辨識支援情況。
- 新增 82 旅 Sheet 健康診斷。

### v5.2

- 活動履歷新增「團員自行申報 → 領袖審批」，原註解對齊 VSBADGE v8.4/v8.5。
- `initializeSheets()` 可補建「待批履歷」，不影響既有資料。
- 新增 `requestLogRecord`、`getLogRequests`、`reviewLogRequest`、`cancelLogRequest`。
- 團員只能為自己申報；修改申報只限自己的紀錄，批准後沿用同一 `record_id` 更新，後續修改須重新審批。
- 同一紀錄同時只接受一個待批修改申報；批准前可取消，寫入操作紀錄。
- 進度待批及其他獎章流程維持不變，批准後只有領袖可修改。
- `handleLoad` 新增 `logRequests` 與 `logRequestsSupported`；未登入不回傳待批申報，團員只見自己，領袖可見全部。
- 修正 `handleSaveLogRecord` 更新範圍：第 2–13 欄共 12 欄，與 `setValues` 的資料長度一致。

### v5.2.1

- 帳戶自助申請支援領袖，原註解對齊 VSBADGE v8.2。
- `apply` 只接受 `member` / `branch_leader`；團長及管理員須由現任管理層直接開立。
- 審批按申請角色開戶；審批者權限不足時退回 `member`。

### v5.3.0

- 全團只可有一位在職團長；開戶及角色更新均檢查，換人須先將現任轉為其他角色。
- 領袖以電郵登入，使用內部唯一 `L` 編號；成員申請仍須填寫 10 位 YMIS。
- 原檔首曾記載領袖 YMIS 選填；實作中的領袖自助申請會忽略傳入 YMIS，批准時編配 `L` 編號。領袖直接開戶則可在 YMIS 留空且有電郵時自動編配。
- 開戶者只可建立自己可管理的角色；審批申請只可建立成員／支部領袖，避免手改 Sheet 繞過限制。
- 審批回應提供 `final_role` 與 `temp_password`，首次登入須更改密碼。
- 缺少 `force_change_password` 欄時自動補上，毋須重新初始化工作表。

### v5.3.1

- YMIS／Email 唯一性檢查涵蓋停用帳戶、成員名單及待審批申請，禁止重複開戶。
- 用戶管理合併 Users 與成員名單，讓匯入但尚未開登入帳號的團員也可見、可管理。

### v5.3.2

- 領袖可在用戶管理直接設定成員新密碼，沒有電郵也可當面告知。
- 覆寫並重新部署即可，毋須初始化。

### v6.0 註記／ecportal v4.1.0 整合

- 信任鏈 `sig` 支援上層領袖／成員與家長入口；家長只讀本團子女聯集，不可寫入或審批。
- 入口開關 `ALLOW_LOCAL_LOGIN` 預設開啟，可由上游有效 `sig` 控制；本地登入／申請受開關控制，上游管理與 SUPER 恢復入口保留。
- GS 舊註解「本端登入永遠可用」未反映後來加入的入口開關，不應作為現行行為依據。
- 簽名格式及整合說明見 [整合文件](../docs/INTEGRATION_ECPORTAL_V4.md)，現行中央登入流程見 [README](../README.md)。

## 維護注意

- GAS HMAC 使用 `Utilities.computeHmacSha256Signature(value, key, charset)`；舊程式曾誤用 API 名稱與參數，造成與 Node crypto 的簽名不一致。
- 簽名使用收到的原始 `scope` JSON 字串，不可解析後重新 stringify 再計算。
- `diagnoseCentralLogin()` 為只讀診斷；Apps Script 編輯器的 `getUrl()` 可能回傳 `/dev`，須核對部署 URL 尾段。
- 舊中央登入 verifier／bootstrap API 暫留相容用途；目前中央登入是 Vercel 驗證 `SUPER_KEY` 後，以本團 `API_KEY` 單向授權 GS。
- 未來新增版號及更新紀錄請寫入此文件或 Git 提交說明；GS 只保留執行程式與必要設定、安全及相容性註解。

# ScoutBadge｜童軍支部進度及行政平台

ScoutBadge 是為香港童軍支部設計的進度紀錄、專科徽章及領袖行政工具，讓領袖可在網頁完成日常管理，而資料仍由各旅團既有的 Google Sheet 與 Apps Script 處理。

## 主要功能

- 2026 年修訂版《童軍訓練綱要》：會員章、探索、標準、高級、總領袖獎章及專科徽章進度（2026-08-15 生效，P022/2026）
- 訓練綱要過渡安排（2017 → 2026）：章級對照、細項比對參考、保留舊清單紀錄 ID、領袖核實後自行記錄舊獎章過渡等同（不刪改舊進度、不自動勾選新細項），見 `docs/SCHEME_TRANSITION.md`
- 回報／意見即時傳送狀態：顯示「傳送中 → 已確認收到／未接收／未能確認」，傳送中防重複點擊、內容保留、未確認時須確認才重送
- 成員完成申請與領袖審批、批量開戶及 SCOUT ID 匯入
- **SCOUT ID 命名（GS `6.5.0`）**：系統統一叫 **SCOUT ID**（即童軍總會 YMIS 內那 10 位數字童軍成員編號），
  API／JSON 正式欄位為 `scoutId`。舊稱呼 `ymis` 仍**完全向後相容**：舊請求照收、回應同時附上 `ymis` 鏡像、
  舊旅團 Sheet 的 `ymis` 表頭照讀照寫（見「舊資料相容」）
- 登入與密碼安全（GS `6.5.0`）：`PBKDF2-HMAC-SHA256`（10,000 次迭代＋每戶隨機鹽；6.2.0／6.3.0 的 120,000 次在 Apps Script 要 20–40 秒，會撞 proxy 上游逾時，見 [docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「登入回『後端服務連線逾時』」；舊版 64-hex 與舊 120,000 次雜湊首次登入自動改寫）、連續 5 次錯密鎖定 15 分鐘、公開入口反枚舉、嚴格職級重設權限階梯，以及三條找回密碼路徑（無電郵成員由領袖重設、已登記電郵領袖以 8 位重設碼自助重設、預設管理員回報 APP ADMIN 重設；見 [docs/PASSWORD_RESET.md](docs/PASSWORD_RESET.md)）
- 小隊、私隱範圍、小隊完成率及活動履歷
- PT/18、P120A1／P120A2 等童軍支部表格資料帶入及列印（表格分項、權限清單及獎章內容全部以童軍支部綱要為準，見 [docs/SCOUT_SECTION_AUDIT.md](docs/SCOUT_SECTION_AUDIT.md)）
- 主系統 Portal 的旅團選擇與嵌入入口（⚠️ 主系統仍在開發中，前端介紹已暫時隱藏，暫停對外推廣）
- 同源 API 代理：瀏覽器只呼叫 `/api/proxy`，後端 URL 與 API Key 不會回傳給瀏覽器

## SCOUT ID 與舊資料相容

童軍總會的青少年會員資料系統叫 **YMIS**，裡面那 10 位數字才是 **SCOUT ID**（童軍成員編號）。
本系統由 GS `6.5.0` 起一律用 **SCOUT ID** 這個叫法，JSON 欄位統一叫 `scoutId`
（同 ROVERBOOK／ROVERBADGE 一致）。舊稱 `ymis` 仍然完全照用：

| 項目 | 新 | 舊（仍然支援） |
| --- | --- | --- |
| 介面文字 | 「SCOUT ID」 | — |
| API／JSON 欄位 | `scoutId` | `ymis`（讀取時照收，回應亦會附上同值的 `ymis` 鏡像） |
| 新建 Sheet 表頭 | `scout_id` | 既有旅團的 `ymis`／`YMIS` 表頭照讀照寫，**毋須手改** |
| CSV 範本 | `scout_id` | 舊 `ymis` 表頭照樣讀得入 |

換句話說：

- **旅團唔需要做任何事**。既有 Google Sheet 一個欄都唔會改，亦唔會多插一個 ID 欄。
- 舊 BADGE／舊旅系統／舊匯出檔繼續送 `ymis`、`target_ymis` 都收；佢哋讀回應的 `ymis` 亦照舊有值。
- 只有 `initializeSheets()` **新建**的資料表才用 `scout_id`；唔可以自己手動改名或加第二個 ID 欄
  （加了會令同一人有兩欄 ID，以第一欄為準）。
- 回歸測試：[test/scout-id-compat.test.js](test/scout-id-compat.test.js)（新表頭、舊表頭、舊輸入、鏡像輸出、CSV、批量開戶全覆蓋）。

## 旅團部署設定

每個旅團以 Vercel Environment Variables 登記，編號就是變數名稱的一部分：

```text
TROOP_0082_NAME=第 82 旅
TROOP_0082_BACKEND=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
TROOP_0082_APIKEY=...
```

三項必須完整。`0082` 和 `82` 是不同的識別字；系統不會補零、去零或建立別名。公開的 `/api/troops` 只回傳旅團編號、顯示名稱，以及（若有改過編號）`legacyIds`；不含後端 URL 或 API Key。編號必須穩定。與 SCOUTBOOK 的配合及三項決定見 [docs/partner-scoutbook.md](docs/partner-scoutbook.md)。

新旅團與既有旅團接入請見 [TROOP_ONBOARDING.md](TROOP_ONBOARDING.md)；Vercel 與 Portal 設定見 [VERCEL_ENV_SETUP.md](VERCEL_ENV_SETUP.md)。

## 主系統整合（ecportal v4.1.0）

> ⚠️ **暫停對外推廣（2026-10）**：主系統（scoutsystem-2.0）未開發完成，所有面向領袖嘅主系統介紹已喺
> `index.html` 用 `[主系統暫時隱藏]` 標記註解隱藏，現階段只推廣進度追蹤系統本身。
> 以下內容及整合程式碼（sig／portal 流程）**全部保留並照常運作**，僅供開發／維運參考；主系統完成後
> 搜尋 `[主系統暫時隱藏]` 解除註解即可重啟介紹。

ScoutBadge 係底層**支部進度追蹤系統（leaf）**，可被上層容器（童軍支部管理系統／旅管理系統）接入。整合採**信任鏈 sig**（HMAC-SHA256，用本團 API Key 簽名，leaf 逐次驗簽）；**三個入口並存**：本團密碼登入永遠可用，上層 sig（成員／領袖）與家長 sig（子女聯集、只讀）是額外免檢入口，上層接入唔會停用本團登入。

- 合約細節、sig 格式、endpoint 列表：[docs/INTEGRATION_ECPORTAL_V4.md](docs/INTEGRATION_ECPORTAL_V4.md)
- 中央登入（`sheep`）失敗排查：[docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「中央登入（sheep）失敗」

## 接入資料顯示與「系統介紹」

- 旅團的接入資料**只提供 API Key**：Sheet 選單「🔗 旅系統 → 🔑 顯示 API KEY（交 ADMIN）」、
  `initializeSheets()` 完成彈窗、`showApiKey()`／`showVercelEnv()`／`vercelEnvLines()` 都只顯示
  `API Key = …`，不再顯示 `ScriptApp.getService().getUrl()`、舊 `WEBAPP_URL` 快取或任何推算網址。
- 部署 URL 的唯一來源是 Google「部署 → 管理部署」視窗；用戶取得 URL 後，自行在原有 ADMIN FORM
  填寫旅團編號、名稱、URL 及 API Key。初始化**不要求**先設定旅團編號，亦**沒有**新增把 URL 貼進
  Apps Script 的設定步驟。
- 首頁新增「🌿 系統介紹」分頁（及部署頁雙向入口），沿用通用「支部進度追蹤系統」介紹圖
  （[assets/system-introduction-zh-hant.webp](assets/system-introduction-zh-hant.webp)），另有中英文字
  說明及安全邊界；不披露任何保留帳號資訊。
- 調查及處理紀錄：[docs/BACKEND_URL_DIAGNOSIS.md](docs/BACKEND_URL_DIAGNOSIS.md)。
- 回歸測試：`test/credential-display.test.js`、`test/system-intro.test.js`（已納入 `npm test`）。
- 合約 e2e 對真 `apps-script/Code.gs` 執行（`test/e2e_realgas.test.js`），已納入 `npm test`

## 旅系統接駁（旅 > 團 > 進度）

同一份 `apps-script/Code.gs` 部署在每一層。上游在 Sheet 選單「🔗 旅系統 → ➕ 登記下游（URL + SHEET KEY）」
登記下游後，就可以經 `sig`（HMAC-SHA256，根密鑰＝下游 SHEET KEY）讀寫下游；下游 Script Properties 的
`ALLOW_LOCAL_LOGIN` 未設定＝開啟（現有旅團零影響），一旦閂口，下游只收上游 `sig`。
同一選單另有「📤 匯出 JSON（含 hash）／📥 匯入 JSON（`upsertUser` 直插 hash）」，用嚟把舊進度嘅密碼 hash 搬去新支部
（匯出檔只寫私人 Drive，匯入零失敗會自動入垃圾桶；有失敗就保留檔案）。

- 完整規格、接入步驟、掣值表、action 白名單：[operations/TROOP_LINK_UPGRADE.md](operations/TROOP_LINK_UPGRADE.md)（維運文件，只留 Git，不部署）
- 守護測試：`npm run test:link`（10 項，載入真實 `Code.gs` 起上下游兩節點對打）

## 升級既有旅團

更新既有 Apps Script 時，用純文字開啟 `apps-script/Code.gs`，全選複製，在 Apps Script 編輯器全選蓋掉原本 SCRIPT 再貼上（不要用 Google 文件或 Word 打開，不要附加在舊程式後面），然後必須在 Apps Script「部署 →
管理部署作業」為**既有 Web App** 建立**新版本**（`/exec` URL 會保持不變）。只覆寫編輯器
內的程式碼並不會改變 `/exec` 所提供的版本，這是升級後功能「似有冇效」最常見的原因。

**最新版本（2026-11-06，GS 6.6.0）需要執行一次初始化**：按選單「🔗 旅系統 → 🔧 初始化／更新」一次
（等同 `initializeSheets()`），補齊缺失工作表及設定，並在 Script Properties 記錄初始化版本。
呢個選單動作係**唯一嘅更新入口**：貼上任何新版本 `Code.gs` 後再按一次即可，只增不刪、可重跑，
唔會刪改既有資料或更換 API Key，亦唔需要搵 `repairSheets()` 等其他按鈕。前端首頁、登入頁及登入後主頁會
顯示最新公告及「重新檢查」按鈕，分別核對 GS 程式版本與初始化版本；只有兩者都完成才顯示綠色「已核對」。

**資料保全硬性規則**：所有補丁不得修改、刪除、覆寫、重置或擅自遷移用戶現有資料（帳號、成員、SCOUT ID、
新舊 ID 進度、徽章、活動履歷、備註、旅團設定）。初始化只做向後兼容的新增，已有值一律保留，現有 API Key 不得更換。
初始化函式（`initializeSheets()`，即選單「🔧 初始化／更新」）只用於**向後兼容的新增**：
補建缺失工作表／欄及版本標記；它不得、也不會改動現有工作表名稱、欄位值、帳號或排序，
所以每次更新 GS 都可以安心重跑同一個動作。

## 開發與檢查

GS 版號及歷史更新集中於 [Apps Script 維護紀錄](apps-script/CHANGELOG.md)，不隨 GS 下載檔或網站部署發布。

```bash
npm run check   # 語法檢查（含 index.html 與 Code.gs）
npm test        # 單元 + 真實 HTTP 端到端（含 mock GAS 旅團、中央登入回打驗票全循環）
npm run dev     # 本機預覽：mock 旅團 0082 + 開發伺服器（預設 port 3000）
npm run build   # 產生 public/
node server.js  # 只有開發伺服器（不帶 mock）
```

`npm test` 中的 `test/e2e_http.test.js`會啟動真實 dev server 與兩個 mock GAS 旅團，走完整 HTTP 流程：旅團清單、登入、讀取／寫入、跨旅團隔離、中央登入（Vercel 核對 SUPER_KEY → 封一張 1 分鐘短效票 → 葉端回打 `/api/verify-super-ticket` 驗票 → 驗過先發 session）、新旅團接入申請。改動 Proxy、Registry 或 Code.gs 的 API 層後，以它作為部署前的最後一道門。

開發伺服器會綁定 `0.0.0.0`。部署範圍、依賴與圖片原則見 [DEPLOYMENT_HYGIENE.md](DEPLOYMENT_HYGIENE.md)。

## 部署

Vercel 的 Output Directory 是 `public/`，由 `npm run build`（`build.js`）在建置時產生，內容只有瀏覽器需要的 `index.html`、`assets/`、`data/`、`docs/`，以及 `apps-script/Code.gs`（開團步驟 1 的官方下載檔）。`vercel.json` 已固定 `outputDirectory`，並覆蓋 Dashboard 的 Build 設定，所以不需要在 Project Settings 手動調整；`public/` 是建置產物，已列入 `.gitignore`，不要提交。

`api/` 留在專案根目錄，由 Vercel 偵測為 Functions，每個 Function 自行 bundle 所需的 `lib/`。`lib/`、`server.js`、`package.json`、測試與腳本都不會出現在公開靜態目錄。

`vercel.json` 同時固定三件事，Project Settings 不需手動調整：

- `buildCommand: npm run build` —— Vercel 建置時執行 build.js 產生 `public/`（沒有這一行，`public/` 不會在部署時被建立，靜態頁面會全部 404）
- `outputDirectory: public` —— 公開靜態目錄只有 `public/`
- `functions` —— 三個 API 的 `maxDuration` 設為 60 秒（GAS 冷啟動可能超過預設上限，超時會回 504）

## 資料來源

- https://scoutsinfohub.org.hk/scout-training-scheme（2026 年修訂版綱要；各專科徽章個別 PDF 連結，最近更新 2026-09）
- https://www.scout.org.hk/uploads/tc/circulars/23585/p022-26.pdf（總會通告 P022/2026：2026 年修訂版實施及過渡安排）
- https://scoutsinfohub.org.hk/ScoutTrainingScheme/FullVersion-zh.pdf（舊版 2015／2017 全本，僅作 2017 版過渡對照之用）
- https://www.scout.org.hk/uploads/tc/circulars/23262/p013-26.pdf

### 中央登入：回打驗票（對齊 VS／RS）

中央登入＝**Vercel 封票、GAS 回打驗票**。Vercel 核對 `SUPER_KEY` 之後，只向已登記旅團後端發送 `superLogin` ＋ 一張用 `SUPER_KEY` 封（AES-256-GCM）嘅 **1 分鐘短效票**（票內綁旅團編號、後端 `/exec` 雜湊、身份 `sheep`，密碼永不出 Proxy）；GAS 收到票之後**回打固定端點** `SUPER_VERIFY_URL`（`apps-script/Code.gs` 常數，預設 `<本部署域名>/api/verify-super-ticket`）驗票，驗過先發 session。**本團 `API_KEY` 單獨唔再可以開中央 session**（舊版單向授權已停用）。

- 驗票端點係**常數**：唔可以由請求／前端指定（否則有人可以叫後端把票連 `API_KEY` 送去自己部機再開 session）。只有 `127.0.0.1`／`localhost` 可以做本地測試覆寫。
- 同一張票**只可換一次** token（GAS `CacheService` 記 120 秒，長過票嘅 60 秒壽命）。
- 失敗一律 **fail closed**：冇票／爛票／錯後端／錯 KEY／重放 → `401`；驗票端點連唔到 → `503`（**唔會**回退單向授權）。回應只含 `{valid: true|false}`，唔會洩漏密碼、session 或失敗原因。
- **首次要在 Apps Script 編輯器執行一次 `testTrustedTicketVerifier` 授權 `script.external_request`**（Apps Script 對外請求權限，一次性人手批准），之後「測試連線」會真探測端點（GET 應回 405）＋回報旅團登記／KEY／後端一致性。
- 瀏覽器不能直接呼叫 Proxy 的 `superLogin` 或控制授權旗標。`API_KEY` 是伺服器授權憑證，不可公開。

更新時須同時部署 Vercel 程式碼，並將 `apps-script/Code.gs` 覆寫到 GAS，在「部署 → 管理部署作業」編輯既有 Web App、建立新版本，保留原 `/exec` URL。舊版（單向授權）GAS 見到 Vercel 送票會回 `401`，Proxy 會轉譯成「後端仍未支援中央登入回打驗票」並叫你去建立新版本；不會以 fallback 繞過驗票。

自架／自訂域名：改 `apps-script/Code.gs` 內 `SUPER_VERIFY_URL` 一行（其餘唔使設定）；舊「中央登入設定」介面（`configureTrustedTicketVerifier`）現只用於本地 loopback 測試覆寫，線上會直接拒並顯示要改常數。維運細節與逐項對照見 `operations/TROOP_LINK_UPGRADE.md` 第 12 節（只留 Git）。

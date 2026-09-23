# ScoutBadge｜童軍支部進度及行政平台

ScoutBadge 是為香港童軍支部設計的進度紀錄、專科徽章及領袖行政工具，讓領袖可在網頁完成日常管理，而資料仍由各旅團既有的 Google Sheet 與 Apps Script 處理。

## 主要功能

- 會員章、探索獎章、標準獎章、高級獎章、總領袖獎章及專科徽章進度
- 成員／領袖帳戶申請、前端審批、批量開戶及 YMIS 匯入
- 成員完成申請與領袖審批
- 小隊、私隱範圍、小隊完成率及活動履歷
- PT/18、PT/120A 等表格資料帶入及列印
- 主系統 Portal 的旅團選擇與嵌入入口
- 同源 API 代理：瀏覽器只呼叫 `/api/proxy`，後端 URL 與 API Key 不會回傳給瀏覽器

## 旅團部署設定

每個旅團以 Vercel Environment Variables 登記，編號就是變數名稱的一部分：

```text
TROOP_0082_NAME=第 82 旅
TROOP_0082_BACKEND=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
TROOP_0082_APIKEY=...
```

三項必須完整。`0082` 和 `82` 是不同的識別字；系統不會補零、去零或建立別名。公開的 `/api/troops` 只會回傳旅團編號與顯示名稱。

新旅團與既有旅團接入請見 [TROOP_ONBOARDING.md](TROOP_ONBOARDING.md)；Vercel 與 Portal 設定見 [VERCEL_ENV_SETUP.md](VERCEL_ENV_SETUP.md)。

## 主系統整合（ecportal v4.1.0）

ScoutBadge 係底層**支部進度追蹤系統（leaf）**，可被上層容器（童軍支部管理系統／旅管理系統）接入。整合採**信任鏈 sig**（HMAC-SHA256，用本團 API Key 簽名，leaf 逐次驗簽）；**三個入口並存**：本團密碼登入永遠可用，上層 sig（成員／領袖）與家長 sig（子女聯集、只讀）是額外免檢入口，上層接入唔會停用本團登入。

- 合約細節、sig 格式、endpoint 列表：[docs/INTEGRATION_ECPORTAL_V4.md](docs/INTEGRATION_ECPORTAL_V4.md)
- 中央登入（`sheep`）失敗排查：[docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「中央登入（sheep）失敗」
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

更新既有 Apps Script 時，覆蓋 `apps-script/Code.gs`，然後必須在 Apps Script「部署 →
管理部署作業」為**既有 Web App** 建立**新版本**（`/exec` URL 會保持不變）。只覆寫編輯器
內的程式碼並不會改變 `/exec` 所提供的版本，這是升級後功能「似有冇效」最常見的原因。
本次設定改動不需要、也不應以初始化函式（`initializeSheets()`／`repairSheets()`）來變更
現有工作表名稱、欄位或資料。

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

- https://scoutsinfohub.org.hk/
- https://scoutsinfohub.org.hk/scout-training-scheme
- https://scoutsinfohub.org.hk/ScoutTrainingScheme/FullVersion-zh.pdf
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

# 旅系統升級（旅 > 團 > 進度）— 接駁規格（ScoutBadge leaf）

> **維運文件，只留 Git**：`operations/` 已在 `.vercelignore`，`build.js` 的靜態白名單（`index.html`、`apps-script/Code.gs`、`assets/`、`data/`、`docs/`）亦不包括本目錄，所以唔會部署到公開網站，團員／領袖睇唔到。
>
> **本檔＝ScoutBadge 呢一輪升級嘅規格／版號唯一記錄**：程式碼內唔寫 `// vX.X` 註解，版號只留本檔（第 9 節）。本檔同時係其他支部照抄嘅依據（對齊 vsbadge `operations/TROOP_LINK_UPGRADE.md`（PR #19）、roverbadge `docs/TROOP_UPGRADE_2026.md`（PR #23／#24））。
>
> **本輪改動範圍**：`apps-script/Code.gs`（新增旅系統兩節＋`doGet`／`doPost` 路由＋初始化提示）、`test/troop_link.test.js`（新增 10 項守護）、`package.json`（`test` 加入新測試、新增 `test:link`）、`.vercelignore`（排除 `operations/`）、`README.md`／`docs/INTEGRATION_ECPORTAL_V4.md`／`apps-script/CHANGELOG.md`（文字更新）、本檔。**前端 `index.html` 及 `api/` 一字未改**。

---

## 0. 一句話

同一份 `Code.gs` 部署喺每一層（旅／團（支部）／進度）。**上游登記下游嘅 URL + SHEET KEY 就可以讀寫下游**，所以進咗上游就等於進咗下游；為咗同步安全，開咗上游之後，**用戶可自行決定幾時閂下游直接入口**（`ALLOW_LOCAL_LOGIN`），閂口後下游只收 `sig`。

**接入完全自願**：唔登記下游、或者登記咗但唔閂口，現有旅團一切照舊（掣未設定＝開啟，行為零變化，測試 1 守呢條）。

### 0.1 定位（寫死，免得錯期望）

| | 進度追蹤（本 repo） | 團／旅系統 |
|---|---|---|
| 概念 | 記錄冊 — 記進度、記履歷、記獎章 | 管理 — 開戶、模組、權限、通告、財務、移交 |
| 位置 | 最下游 leaf（1 團 1 張 SHEET ＋ 一支 `/exec`） | 上游（團＝支部系統；旅＝旅系統） |
| 狀態 | 已完成嘅系統，本輪只升級「接駁」 | 以 ecportal 為基礎作參考，未完成 |
| 本檔範圍 | ✅ 接駁、sig、掣、開戶、吐 JSON | ❌ 唔屬本檔（模組註冊、跨支部權限、邀請連結、通告訂閱、ADMIN APP、財務…） |

「進度追蹤冇模組註冊／通告／財務／權限樹」＝正常，唔係缺失：嗰啲係管理層（團／旅系統）嘅嘢。進度 leaf 只做三件事：**被登記、被上游用 sig 讀寫、本地直接入口自己開住／由上游閂**。

---

## 1. 變數 ABCD（四個都唔寫入 SHEET）

| 代號 | 名稱 | 邊個產生 | 放喺邊 | 用途 |
|---|---|---|---|---|
| **A** | `SUPER_KEY` | 現有（隱藏） | Vercel env | 超管登入。**與旅系統無關，本輪不改動、不在任何選單顯示** |
| **B** | `TROOP_(id)_BACKEND` | GS 部署後抄（`ScriptApp.getService().getUrl()`） | Vercel env；上游則存 `DOWNSTREAM_<id>_URL` | 主系統 proxy／上游打去邊個 GAS |
| **C** | `TROOP_(id)_NAME` | 你自填 | Vercel env | 前端旅團顯示名（純文字） |
| **D** | `TROOP_(id)_APIKEY` | GS 生成（存 Script Properties `API_KEY`） | Vercel env；上游則存 `DOWNSTREAM_<id>_KEY` | API key，同時係 `sig` 嘅根密鑰（第 3 節） |

- **一次過抄 B + D**：Sheet 選單「**🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY（交 ADMIN）**」。
- **交 ADMIN**：經收件匣（首頁「📋 新旅團部署」→ `submitRegistration` → `/api/proxy` → 伺服器端固定嘅中央收件端點）。交 B、C、D；ADMIN 入 Vercel env 後 Redeploy。
- **四個都唔寫入任何工作表**：B/D 只存 Script Properties（同 Vercel env），C 由你填，A 隱藏。`test/troop_link.test.js` 會掃晒所有工作表，確保冇後端 URL、冇 API KEY、冇 `ALLOW_LOCAL_LOGIN` 字樣。
- 換 D（撤銷舊 key）＝三處同步（漏一處就靜靜打唔通）：① 下游 Script Properties 刪 `API_KEY` → 跑 `showApiKey()` 生成新 key；② 上游重新登記下游；③ ADMIN 改 Vercel env + Redeploy。

---

## 2. 上下游接入

```
        旅 GAS ──── sig ────▶ 團（支部）GAS ──── sig ────▶ 進度 GAS（本 repo）
          │                        │                          │
   登記下游 B + D            登記下游 B + D            ALLOW_LOCAL_LOGIN
   DOWNSTREAM_<id>_URL      DOWNSTREAM_<id>_URL        （直接入口掣）
   DOWNSTREAM_<id>_KEY      DOWNSTREAM_<id>_KEY
```

- **每層都係同一份 `Code.gs`**：一個節點可以同時係上游（對住自己嘅下游）同下游（對住自己嘅上游）。
- **上游 Script Properties**：`DOWNSTREAM_<id>_URL`、`DOWNSTREAM_<id>_KEY`、`DOWNSTREAM_<id>_NAME`、`DOWNSTREAM_<id>_AT`。`<id>` 由你改（例：`progress`、`sc0082`、`branch-a`），只可用英文／數字／底線／連字號，最長 32 字元。旅對住幾個團就登記幾條。
- **下游 Script Properties**：`ALLOW_LOCAL_LOGIN`（未設定＝開啟，現有旅團零影響）。
- **掣在上游**：上游選單「🚪 下游直接入口 → 🔒 閂口（只收 sig）／🔓 開啟」，經 `sig` 打下游 `setLocalLogin`。下游自己都有同一個掣（「🚪 本機直接入口」），只作未接上游時獨立運作／災難恢復；一掛接上游，以上游為準。
- **接入步驟（每團照做）**：

| 步驟 | 做乜 | 邊度做 |
|---|---|---|
| 1 | 部署 GS，抄 B 的 URL，生成 D | 每層 Sheet → Apps Script → 部署（執行身分「我」、存取權「任何人」）→ 選單「🔗 旅系統 → 🔑 顯示 BACKEND／APIKEY」 |
| 2 | 填 C，連 B/D 經收件匣交 ADMIN | 首頁「📋 新旅團部署」表單（前端冇改，照舊用） |
| 3 | 每團補一張支部 SHEET，與現有進度 SHEET 成對 | 新 Sheet → 貼同一份 `Code.gs` → `initializeSheets()` → 部署 → 抄 B/D |
| 4 | 上游登記下游，再測連線 | 上游選單「➕ 登記下游（URL + SHEET KEY）」→「📡 測試下游連線（sig）」 |
| 5 | 搬舊數（第 7 節） | 舊進度「📤 匯出 JSON（含 hash）」→ 新支部「📥 匯入 JSON」 |
| 6 | 核對無誤後閂下游直接入口 | 上游選單「🚪 下游直接入口 → 🔒 閂口」（有確認彈窗，提醒先完成匯入及連線測試） |
| 7 | 之後開戶一律在上游 | 上游選單「👤 為下游開戶（揀團）」 |

- 每層升級：Apps Script → 用新 `Code.gs` 全檔覆蓋 → 部署 → **管理部署 → ✏️ 編輯 → 版本選「新版本」**（`/exec` URL 唔變，Registry 唔使改）。
- **只有全新嘅支部 SHEET 先執行 `initializeSheets()`**；現有進度 SHEET 唔好重跑（唔改 schema、唔清資料）。

---

## 3. `sig` 點計（GAS → GAS，唔經 Vercel proxy，不設回調）

```
根密鑰    = 該節點的 SHEET KEY（D）
sigKey    = hex( HMAC-SHA256( message = "scoutbadge-troop-sig-v1", key = D ) )
canonical = action + "\n" + ts(毫秒) + "\n" + nonce + "\n" + hex(SHA-256(rawBody))
sig       = hex( HMAC-SHA256( canonical, sigKey ) )
```

- **上游簽出站用「下游的 D」**（登記咗嗰條）；**下游驗入站用「自己的 D」**。密鑰以用途字串分隔推導，推導結果唔落地、唔儲存。
- **兩組 sig 一齊送**（GAS 302 轉址會遺失 query）：
  - query：`?sig=…&sts=…&snonce=…`，digest 綁完整原始 body；
  - body：`{ …, sig, sig_ts, sig_nonce }`，digest 綁「去掉三個 sig 欄位後的 body」。
  - 下游先驗 query，驗唔到再驗 body；**兩組 nonce 一次過消耗**，堵死「第一次只驗到其中一組、重放時用另一組」嘅缺口。
- **防護**：時窗 ±5 分鐘（未來時間戳都拒）／nonce 一次性（`CacheService` 10 分鐘）／body ≤ 900 KB／`sig` 必須 64 位 hex／比較用「兩邊先各自 SHA-256 再比對」避免逐字元短路／**一律 POST，唔收 GET 帶 sig**。
- 登記下游時 **URL 必須係正式 GAS `/exec`**（`https://script.google.com/macros/s/…/exec`），其他一律拒。
- **`<purpose>` 每個 repo 一條**：本 repo ＝ `scoutbadge-troop-sig-v1`（寫死喺 GS 常數）。上游同下游必須係同一個 repo 嘅同一條字串；**跨 repo 直連唔支援**（已知邊界，唔係 bug）。

### 3.1 action 白名單（本 repo 自己的 action set）

- **讀（12）**：`load`、`getLoginMode`、`getLinkState`、`getMembers`、`getConfig`、`getAllUsers`、`getOtherBadges`、`getPendingRequests`、`getApplications`、`getLogRecords`、`getLogRequests`、`getAuditLog`
- **寫（19）**：`save`、`saveOtherBadge`、`requestComplete`、`reviewRequest`、`addMember`、`addUser`、`bulkAddUsers`、`upsertUser`、`importUsers`、`importAll`、`resetPassword`、`setPw`、`setStatus`、`updateUserRole`、`updatePermissions`、`saveLogRecord`、`deleteLogRecord`、`reviewLogRequest`、`setLocalLogin`
- **永不接受（即使有 sig）**：`login`、`apply`、`logout`、`changePassword`、`updateConfig`、`requestLogRecord`、`cancelLogRequest`、`portalLogin`，以及白名單以外任何 action。
- 每筆簽名**寫入**都會喺下游「操作紀錄」留一行（操作者 `upstream`，詳情含 `on_behalf`），**讀取唔留**。上游傳嚟嘅標籤會先消毒（`linkActorLabel`，只留 `0-9A-Za-z_.@-`），寫入工作表嘅文字經 `safeSheetText`，防儲存格算式注入。
- **上游讀得到下游幾多**：讀 action 令上游可以直接讀下游（成員、用戶清單、日誌…）；回應永不含 `password_hash`（測試 8 守）。hash 讀唔到，所以搬舊密碼只可以行第 7 節嘅「JSON 吐出」。
- 少數管理 handler（`resetPassword`／`updateUserRole`／`updatePermissions`）會用 `getUser(managerYmis)` 再核對本地權限；上游操作者唔一定有本地帳戶，所以只在真的搵唔到時才退回本機管理員（`ADMIN_YMIS`），審計紀錄照樣記 `upstream` 及 `on_behalf`。
- 舊 Portal 通道（`portalLogin`、`childId|sub|scope|exp` sig、`exportAll`／`upsertUser` 等 apikey 直入）**仍然存在**，但**只會在直接入口開啟時生效**；閂口後一律拒（第 5 節）。

### 3.2 回傳／回調（★ 對齊 VS／RS 實測做法）

- 旅系統 sig 鏈＝**單向**（上游 → 下游），下游同步回一個結果：`{success, data}` 或 `{success:false, error}`。「📡 測試下游連線（sig）」、開戶、匯入、閂口全部靠呢個**同步回傳**先知道成唔成功；失敗要明講（例：「上游已開戶，但下游寫入失敗」），唔可以靜靜地兩邊唔一致。
- **旅系統冇非同步回調**：冇 callback endpoint、下游唔會主動回打上游；亦冇定時器／`onEdit` 觸發器（全倉掃 `callback|postMessage|newTrigger|onEdit` 零命中）。
- 「中央登入回打」係另一條鏈（登入鏈，唔屬旅系統）：vsbadge／roverbadge 已經改成「GAS 收到 `login` 帶 `super_ticket` → 回打固定端點 `<app>/api/super` 驗票 → 驗過先發 token」並實測成功。**ScoutBadge 現時係零回打版**（Vercel 驗 `SUPER_KEY` → `action=superLogin` 單向授權），對齊屬**本輪範圍外**：見第 8 節「不改 A／不改 `api/`」及第 11 節「已知邊界」。本輪不動中央登入，只確保**閂口後中央登入（A）照樣放行**（與旅系統閘門脫鉤）。

---

## 4. 掣 `ALLOW_LOCAL_LOGIN`（寫喺下游，fail closed）

| 掣值 | 行為 |
|---|---|
| 未設定（預設） | **開啟** — 現有旅團零影響；`initializeSheets()` 唔會自動寫值 |
| `1`／`true`／`yes`／`on`／`open`（大小寫／空白不敏感） | **開啟** |
| 其餘任何值（`false`／`0`／`no`／`off`／`close` 或串錯字） | **閂口（fail closed）** |

### 閂口後行為對照

| 請求 | 未設定／`true` | `=false`（閂口） |
|---|---|---|
| 前端直接 `login`／`apply` | 照舊 | **拒**，回 `{success:false, upstream_only:true, error:"…只接受上游簽名（sig）請求…"}` |
| `GET ?action=load`／`getLoginMode` | 照舊 | **拒**（同一訊息） |
| 舊 Portal／apikey 直接 `save` | 照舊（兼容） | **拒**（apikey 唔再等於授權） |
| 舊 Portal sig（`portalLogin`、`childId|sub|scope|exp`） | 照舊 | **拒** |
| 用戶 token 操作 | 照舊 | **拒** |
| 上游 `sig` 請求（本規格） | **接受** | **接受** |
| 中央登入（A，`superLogin`） | 接受 | **接受**（與旅系統閘門脫鉤） |
| 舊入口掣 `getDownstreamAccess`／`setDownstreamAccess` | 接受 | **接受**（唯二例外；兩者都要先通過 `requireAuthBody`，`setDownstreamAccess` 另要有效 portal sig，否則 403） |

- 閂口係可逆：下游選單「🔓 開啟」，或上游以 `sig` 打 `setLocalLogin(allow=true)`，或舊 Portal 以 sig 打 `setDownstreamAccess(allowLocal=true)`。
- **每個下游至少留一個本地領袖戶 + SUPER 作災難恢復**（中央登入與閘門脫鉤，所以閂口唔會鎖死超管路徑）。

---

## 5. 開戶（閂口後）

**閂口後新戶在上游揀團開戶，經 `sig` 落下游寫。**

- 上游選單「**👤 為下游開戶（揀團）**」（程式介面 `createAccountForDownstream(id, rawUser, manager)`）：① 上游本地開戶（角色權限、YMIS／Email 唯一性照舊）→ ② 讀回 `password_hash` → ③ `sig` 打下游 `upsertUser`。
- 兩邊**同一個 hash**，所以同一個臨時密碼兩邊都啱用；首登仍然強制改密碼（`force_change_password=true`）。
- `upsertUser` 語義：新戶必須帶 64 位 hex `password_hash`；**帶明文 `password` 一律拒**；同 YMIS（或同 Email 認回同一身份）→ 更新；冇帶 hash → **保留原密碼**；冇帶 branch 唔洗走既有支部；`SUPER_ADMIN_ID`（`sheep`）保留帳號絕不可操作；冪等（重覆推送只更新，唔會開重複列）。
- 上游開戶成功但下游寫入失敗時明講「上游已開戶，但下游寫入失敗：…」，重推用 `upsertUser` 即可。
- **身份錨點**（本檔已內含，唔使翻其他文件）：
  - 成員（SCOUT_ID／YMIS）＝喺該團支部 SHEET 誕生（人手／CSV／批核申請／接收移交）；進度 leaf 唔會自己開成員戶口，搵唔到就係「該團未開戶」，唔會自己補。
  - 領袖（EMAIL）＝所屬層：只帶一團 → 該團支部；旅長／跨團 → 旅層 + 跨支部清單。
  - 家長（EMAIL）：有旅系統 → 旅層；冇旅系統 → 該團支部。
  - 進度 leaf 只係**身份消費者**：唔開戶、唔反寫上游，`upsertUser` 只用作接收上游鏡像／匯入舊數。

---

## 6. 吐 JSON（搬舊數）

**場景**：舊進度有數，新支部空。

1. **舊進度 Sheet**：選單「**📤 匯出 JSON（含 hash）**」→ `exportUsersJson()`
   - 寫成 Drive 檔 `scoutbadge-users-<yyyyMMdd-HHmmss>.json`（建立後即設 `Access.PRIVATE` + `Permission.NONE`），彈窗給連結及檔案 ID；
   - Drive 寫入失敗時，完整 JSON 會寫入「檢視 → 執行紀錄（Logger）」作後備；
   - **只寫 Drive／Logger，绝不寫入任何工作表**；「操作紀錄」只記筆數同檔案 ID（唔記 hash）。
   - 格式：`{ "format": "scoutbadge-users-export", "schema": 1, "exported_at": …, "node": …, "count": n, "users": [ { ymis, name, email, role, branch, squad, can_tick, allowed_badges, status, force_change_password, password_hash, auth_by, created_at, last_login } ] }`
   - 舊 API `exportAll`（前端備份用，可 `include_hash`）**照舊保留**，只會在直接入口開啟時可用。
2. **新支部 Sheet**：選單「**📥 匯入 JSON（upsertUser 直插 hash）**」→ 貼 Drive 連結或檔案 ID → `importUsersFromDrive()` → 逐個 `upsertUser` 直插 hash（保留舊密碼）
   - 只收 64 位 hex `password_hash`；**帶明文 `password` 一律拒**（唔會喺搬數途中重設密碼）；假 hash／壞 JSON／缺 YMIS 一律拒；
   - `force_change_password` 跟隨匯出值（搬舊數唔會逼人即時改密碼）；
   - 一次最多 2000 筆；完成彈窗顯示「新增 X、更新 Y、失敗 Z」及首 8 筆失敗原因；
   - 上游亦可用 sig 推：`callDownstream(id, 'importUsers', { users: [...] })`（或 `{ json: "…" }`／`{ drive_file_id: "…" }`）。
3. **匯完可閂下游直接入口**：核對筆數 → 上游「🚪 下游直接入口 → 🔒 閂口」。
4. **匯入後即刪 Drive 匯出檔**（含 hash）；唔好用共享資料夾或電郵明文傳送。

---

## 7. 唔做

- ❌ 不在 SHEET 寫 ABCD（有測試守）
- ❌ 不改 A（`SUPER_KEY` 相關邏輯、`api/` 超管路徑全部原封不動）
- ❌ 旅系統不設回調（第 3.2 節第 2 條；同步回傳唔算回調）
- ❌ 不改前端 `index.html`、不改 `api/`（`sig` 係 GAS→GAS，唔經 Vercel proxy，所以 proxy 白名單唔使加）
- ❌ 不改現有工作表 schema、不清資料、現有部署唔使重跑 `initializeSheets()`
- ❌ 進度追蹤唔加通告／圖書館／推送／訂閱邏輯（通告／訂閱只屬管理層嘅通告模組）
- ❌ 下游唔自行開成員戶口、唔反寫上游（身份錨點在該團支部）

---

## 8. 清理（版號）

- `apps-script/Code.gs` 及 `assets/batch-onboard/Code.gs` 內所有 `// vX.X` 註解全拆（連 `initializeSheets()` 彈窗嘅版號字樣）——本 repo 早前「GS 瘦身」已完成，本輪再掃一次確認零命中。
- **版號只留本檔**；`test/troop_link.test.js` 第 10 項係守護測試，GS 再出現版號字樣即 fail。
- `operations/`（本檔）同 `test/`（守護測試）已入 `.vercelignore`，亦不在 `build.js` 白名單 → **只留 Git，唔會部署**。`docs/` 內嘅公開文件（例如 `INTEGRATION_ECPORTAL_V4.md`）唔放維運細節。

---

## 9. 驗收（本次實測）

| 項目 | 本版（改後） | 改前（HEAD） |
|---|---|---|
| `apps-script/Code.gs` | 156,236 bytes / 2,718 行 | 112,126 bytes / 2,037 行 |
| `assets/batch-onboard/Code.gs` | 6,840 bytes（未改動） | 6,840 bytes |
| `npm run build` 輸出 | 2,849,467 bytes（16 files） | 2,803,631 bytes（16 files） |
| `index.html`／`api/`／`lib/` | **零改動**（`git diff --stat` 空） | — |

增量分佈：`apps-script/Code.gs` ＋44,110 bytes（旅系統新程式＋註解，全部都係公開下載嘅同一份檔）、
`docs/INTEGRATION_ECPORTAL_V4.md` ＋1,726 bytes（公開合約文字更新）。冇新增工作表、冇新增 runtime 依賴、冇新增圖片；
`operations/`（本檔）同 `test/` 唔入 build output（`.vercelignore` 已排除，`build.js` 白名單亦冇包含）。
| runtime 依賴 | 0 dependencies / 0 devDependencies | 一樣 |

```bash
npm run check      # 語法檢查（含 index.html 同兩份 GS）
npm test           # proxy 54 + e2e HTTP 25 + realgas 15 + 中央登入 10 + troop_upgrade 10 + troop_link 10，全部綠
npm run test:link  # 只跑旅系統守護測試
npm run build      # 產生 public/（部署內容）
```

`test/troop_link.test.js`（11 項：10 項守護 ＋ 選單冒煙；用 in-memory GAS stub 載入**真實** `Code.gs`，起上下游兩個節點經假網路對打）：

1. 直接入口掣未設定時，現有旅團行為完全不變（登入／`load`／`getAllUsers` 照舊，掣唔會被自動寫入）
2. 閂口後：直接 `login`／`apply`／`GET load`／apikey `save`／token 操作全部被拒；中央登入（A）照放行；掣值表 fail closed（`no`／`0`／串錯字都當閂口）
3. 上游登記下游 SHEET KEY 後，`sig` 可讀可寫下游，並可由上游閂／開下游掣；非 GAS URL、太短 KEY、洗走字元後留空嘅編號全拒
4. `sig` 防護：錯 key、竄改 body、過期／未來時間戳、重放 nonce、混合傳送重放、白名單外（`login`、`changePassword`、未知 action）— 全部被拒；query 及 body 兩種傳送都通過
5. ABCD 只存 Script Properties，上下游所有工作表都掃唔到 URL／KEY／掣名
6. 上游揀團開戶 → 下游同一 `password_hash`；重複推送係更新唔係開新列；冇帶 hash 時保留原密碼、冇帶 branch 唔洗走既有支部；保留帳號拒操作
7. 匯出含 hash（Drive 私人檔）→ 匯入 `upsertUser` 後舊密碼直接可登入；重匯冪等；明文密碼／假 hash／壞 JSON／缺 YMIS 全部被拒，操作紀錄冇 hash
8. 上游以 `sig` 批量 `importUsers` ＋ `getAllUsers`（回應唔洩漏 hash）；簽名寫入留紀錄、簽名讀取唔留
9. 上游傳來的標籤不可變成工作表算式（`auth_by`／操作紀錄消毒）
10. GS 內冇版號註解
11. **選單冒煙**（本 repo 加碼）：`onOpen` 建到「🔗 旅系統」選單、每個選單項都指到真實函式（防改壞 `handler` 名），
    登記下游／測連線（sig）／為下游開戶（揀團）／兩個直接入口掣／匯出 JSON／接駁狀態／顯示 BACKEND＋APIKEY／移除登記全部行得通

> 本地測試唔能代替正式 GAS 部署驗收：`sig` 經真實 302 轉址、Drive 權限、Script Properties 配額、`onOpen` 選單授權，都要喺測試旅團真機跑一次先算數。

---

## 10. 安全備註

- **交唔交 D、閂唔閂口，全部係旅團自己嘅決定，冇任何強制**：旅 > 團 > 進度 三層都係同一個旅團自己嘅節點，所以「上游拿到下游完整控制權」本質上係佢自己旅團內部嘅事——唔想就可以唔交。
- **決定交嘅話就要當 D 係完整控制權**：D 一經登記到上游，上游對該節點嘅權限比舊 apikey（只可寫進度）更闊，連帳戶管理都可以。所以 D 只放 Vercel env 同上游 Script Properties，唔入 Sheet、唔入 Git、唔入截圖、唔入聊天。
- 閂口後，**舊嘅 apikey 直寫路徑一併失效**，只剩 `sig`；要撤銷上游存取，就換 D（第 1 節）或移除上游登記。
- `sig` 唔係加密，只係完整性＋來源驗證；payload 內容仍係明文 JSON（GAS HTTPS 傳輸）。所以**唔好用 `sig` 送明文密碼**——搬數只送 hash，開戶下游鏡像只送 hash。

---

## 11. 檔案對照同已知邊界

| 檔案 | 本輪改動 |
|---|---|
| `apps-script/Code.gs` | 新增「旅系統：上下游接駁」及「旅系統：Sheet 選單」兩節（`sig`、掣、下游登記、`callDownstream`、`createAccountForDownstream`、`exportUsersJson`、`linkUpsertUser`／`importUsersFromText`／`importUsersFromDrive`、`handleSignedRequest`、`onOpen` 選單）；`doGet`／`doPost` 加掣及 `sig` 路由；`initializeSheets()` 提示加一行旅系統指引 |
| `test/troop_link.test.js` | 新增（10 項守護測試） |
| `package.json` | `test` 加入旅系統測試；新增 `test:link` |
| `operations/TROOP_LINK_UPGRADE.md` | 本檔（新增，只留 Git，不部署） |
| `.vercelignore` | 排除 `operations/` |
| `README.md`／`docs/INTEGRATION_ECPORTAL_V4.md`／`apps-script/CHANGELOG.md` | 文字更新（公開文件只寫行為，唔放維運細節） |
| `index.html`、`api/*`、`lib/*` | **未改動** |

**其他支部照抄嘅清單（照 VS／RS，已喺本 repo 落地）**：

- `sig` 數學＝`ts` ＋ `nonce` ＋ body digest 雙通道（第 3 節）＋ 12 讀／19 寫白名單 ＋ 永不接受清單（第 3.1 節）。
- `<purpose>` 用自己 repo 一條常數（`scoutbadge-troop-sig-v1`），寫喺 GS 常數，唔好諗住跨 repo 接。
- `DOWNSTREAM_<id>_*` 登記 ＋ `callDownstream()` ＋ 選單（登記下游／測試連線／閂口／為下游開戶／匯出 JSON／匯入 JSON）。
- 開戶錨點（第 5 節）、吐 JSON（第 6 節）、掣值 fail closed（第 4 節）、版號清理（第 8 節）、
  `test/troop_link.test.js` 同等守護測試（第 9 節）。
- 各自 repo 嘅 guide 要對返呢份規格，唔好一個寫「Code.gs 完全不用改」，另一個寫要改 sig。

**已知邊界（照 VS／RS 一致）**：

- **跨 repo 直連唔支援**：上游同下游要同一個 repo（`<purpose>` 同 sig 格式各 repo 一套）。本 repo 係 `scoutbadge-troop-sig-v1` ＋ `action\n ts\n nonce\n sha256(rawBody)`。
- **ScoutBadge 自己仲有一條舊 Portal sig**（`childId|sub|scope|exp`，ecportal 合約）**同時存在**：兩條簽名鏈互不相通，但都係同一個 leaf 嘅入口；閂口後兩條本地鏈都停，只剩本規格嘅 `scoutbadge-troop-sig-v1`。
- **中央登入回打**：ScoutBadge 現時零回打（`superLogin` 單向授權），未改成 VS／RS 嘅「GAS 回打固定端點 `<app>/api/super` 驗票」。原因：本輪明確唔改 A／`api/`（第 7 節）。日後要對齊就需要同時改 GAS 同 `api/`，屬另一輪工作。
- 舊 API（`exportAll`、`upsertUser`（寬鬆版）、`setPw`／`verifyPw`／`setStatus`、`getDownstreamAccess`／`setDownstreamAccess`）**保留**，保障 ecportal 合約唔會斷；但閂口後只有後兩者（`get/setDownstreamAccess`）例外放行，其餘一律要經 sig。

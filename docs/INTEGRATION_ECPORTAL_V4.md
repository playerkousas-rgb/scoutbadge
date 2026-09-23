# ScoutBadge × ecportal v4.1.0 整合（LEAF 合約）

ScoutBadge 係**最底層嘅支部進度追蹤系統（leaf）**。未來會由上層容器系統
（**童軍支部管理系統**、**旅管理系統**）「食」入去。呢份文件定義 ScoutBadge
作為 leaf 需要配合 v4.1.0 信任鏈嘅合約，以及已經實裝咗咩。

> 權威規格：`playerkousas-rgb/readme`（ecportal v4.1.0 FINAL）。本文列明咗同規格
> 嘅**有意偏離**（見「設計決定」）。

---

## 核心原則：三點進入並存

ScoutBadge 有**三個同時並存嘅進入方式**，上層「食」入唔會停用任何一個：

| 入口 | 身份 | 認證方式 | 說明 |
|---|---|---|---|
| 1. 本團密碼登入 | 成員／領袖 | 本地 `Users` 密碼 | 預設新部署啟用（`ALLOW_LOCAL_LOGIN` 未設定＝開啟）。可由上層透過 sig 調用 `setDownstreamAccess` 或 `setLocalLogin` 統一控管。 |
| 2. 上層 sig | 成員／領袖 | 信任鏈 `sig`（免檢） | 上層容器用本團 API Key 簽名，leaf 驗簽後放行。領袖經 sig 入下游無 row 亦可放行並具領袖權限。 |
| 3. 家長 sig | 家長 | 信任鏈 `sig`（免檢） | 家長只看**自己子女（聯集）**，只讀。 |

> **入口開關（上游控、下游寫）設計**：
> - **單獨使用不受影響**：`ALLOW_LOCAL_LOGIN` **未設定＝開啟**，進度追蹤平台獨立使用時完全正常（`initializeSheets()` 唔會自動寫值）。
> - **進度前端無關閉按鈕**：進度前端介面不設「關閉入口」掣，避免單獨使用時誤鎖本團；掣只在上游選單（「🚪 下游直接入口」）或本機 Sheet 選單操作。
> - **上游集中控制**：上層可經**本規格嘅 `sig`** 調用 `setLocalLogin`（新制，見 Git 內 `operations/TROOP_LINK_UPGRADE.md`：維運文件，不部署到網站），或沿用舊制 `setDownstreamAccess({ allowLocal: false })`（必須附帶有效 upstream `sig`，純 apikey 拒絕）關閉本地入口。
> - **掣值 fail closed**：只有 `1/true/yes/on/open` 視為開啟，其餘任何值（`false/0/no/off`、串錯字）＝閂口；未設定＝開啟。
> - **關閉後攔截範圍**：關閉後**本地入口一律拒**（`login`、`apply`、`GET load`／`getLoginMode`、apikey 直接 `save`、用戶 token 操作、舊 Portal `portalLogin`），一律回 `{success:false, upstream_only:true, error:"…只接受上游簽名（sig）請求…"}`。**只有**上游 `sig` 請求、中央登入（與閘門脫鉤，而且只認 Vercel 封嘅短效票：`action=superLogin` ＋ `super_ticket` 回打驗票）及舊入口掣 `get/setDownstreamAccess`（自身再驗 portal sig）照常放行。

---

## 信任鏈 sig（HMAC）格式

上層容器對每次請求用**本團自己嘅 API Key** 簽名。leaf 端逐次驗簽，唔存 session。

```
message = `${childId}|${sub}|${scope}|${exp}`
sig     = HMAC-SHA256( apiKey, message )   // 小寫 hex
```

| 欄位 | 說明 |
|---|---|
| `childId` | 全域 ID（例 `PROG_0082S`）。若 leaf 設咗 Script Property `PORTAL_GLOBAL_ID`，兩邊經 `normId()` 後必須相等（`82S` 同 `0082S` 唔會撞號）。 |
| `sub` | 身分：**成員用 YMIS**（10 位數字）；**領袖／家長用 EMAIL**。 |
| `scope` | **原始 JSON 字串**（簽名必須用同 leaf 端收到嘅完全一樣嘅字串）。例：`{"role":"member"}`、`{"role":"parent","children_ids":["SCOUT_童_1234560001"]}`。家長 scope 只能是 `children_ids`。 |
| `exp` | Unix 秒。上限 3600 秒（`PORTAL_SIG_MAX_TTL`），leaf 容許 60 秒時鐘偏差。 |
| `sig` | 小寫 hex HMAC-SHA256。 |

**leaf 端 `verifyPortalSig()`** 驗證順序：
1. `childId`／`sub`／`scope`／`exp`／`sig` 全部存在。
2. `exp` 未過期（含 60s 容差）、唔超過上限。
3. 重算 HMAC 同 `sig` 比對（constant-time）。
4. 若設咗 `PORTAL_GLOBAL_ID`，`normId(childId)` 必須等於 `normId(PORTAL_GLOBAL_ID)`。
5. 解析身份（見下）。

### 身份解析

| `sub` 形式 | 身份 | 條件 |
|---|---|---|
| 10 位數字 YMIS | **成員** | 本團 `Users`／名冊有呢個 YMIS |
| EMAIL（領袖） | **領袖** | `getUserByEmail` 搵到、角色係領袖（`can_tick`） |
| EMAIL（家長） | **家長** | `role==='parent'`（空視同 parent）；`children_ids` 必須至少一個**喺本團**；只可讀子女聯集 |

- **SUPER id（`sheep`／`L+數字` 中央身份）唔接受** sig —— 中央登入走另外嘅
  **回打驗票**路徑：Vercel 核對 `SUPER_KEY` 後封一張 1 分鐘短效票
  （`api/verify-super-ticket.js` 驗票，`lib/super-auth.js` 封／開票），
  GAS 回打 `SUPER_VERIFY_URL` 常數端點驗過先發 session（見 `README`）。
  中央登入失敗時，失敗關卡（端點連唔到／未授權 `script.external_request`／
  旅團未登記／KEY 唔一致／後端網址唔一致／後端未更新）會變成可行動嘅提示，
  對照表見 `docs/TROUBLESHOOT_82.md`。
- 家長**只讀**：`handleParentAction` 只放行 `load`／`getOtherBadges`／
  `getServiceRecords`／`getMembers`（全部 server-side 收縮到子女聯集）；
  其他 action（寫入、審批、改密碼…）一律 `code:403`。

---

## requireAuth（所有 endpoint）

`doPost`／`doGet` 第一行都叫 `requireAuthBody`／`requireAuthParams`。放行條件
（**任一**成立即可）：

1. 請求帶**正確嘅本團 API Key**（`apikey` 欄位）；
2. 請求帶**有效 sig**（信任鏈）；
3. 請求帶**有效本地 token**（向下兼容舊嘅 token-only 客戶）。

全部唔成立 → `{success:false, code:403, error:'未授權：缺少 API Key 或有效簽名'}`。
（GAS 一律回 HTTP 200，語意喺 `code` 欄位。）

> 若 apikey 同 sig 同時存在，會一併提取 sig 身份（家長 GET load 需要）。

---

## 新 endpoint / action

### `portalLogin`（sig → 本地 token）
上層／成員／領袖用 sig 換**本地 token**，之後跟普通登入一樣用 token 行。
```json
{ "action":"portalLogin", "childId":"...", "sub":"...", "scope":"...", "exp":..., "sig":"..." }
```
- 成員／領袖：成功回 `{success:true, token, user}`。
- 家長：回 `{success:true, view_as:'parent', visible_children:[...]}`（**唔發本地 token**，
  家長用 sig bearer 每個請求附帶 sig）。

### `getRegistrySafe`（server-side 名冊，供上層「吃」）
**只接受 API Key**。回傳**剝皮版**名冊（`getMembers()`）：YMIS、姓名、email、小隊
—— **無密碼 hash、無 token、無私隱欄**。
```json
{ "action":"getRegistrySafe", "apikey":"..." }  →  { "success":true, "members":[...] }
```

### `setDownstreamAccess` / `getDownstreamAccess`（舊制入口開關）
> 新制（旅系統 sig）：`setLocalLogin`／`getLinkState`，見 Git 內 `operations/TROOP_LINK_UPGRADE.md`（維運文件，只留 Git、不部署）。
> 兩制寫同一個掣 `ALLOW_LOCAL_LOGIN`；兩個入口掣係閂口後唯一仍放行的舊制 action（自身再驗 sig）。
- `setDownstreamAccess` **嚴格要求上游 sig**（純 apikey 或無效 sig 均回 403 拒絕）。
  ```json
  { "action":"setDownstreamAccess", "allowLocal":false, "childId":"...", "sub":"...", "scope":"...", "exp":..., "sig":"..." }
  ```
- `getDownstreamAccess` 讀取當前狀態：
  ```json
  { "action":"getDownstreamAccess", "apikey":"..." }  →  { "success":true, "allowLocal":true }
  ```

### `exportAll`（完整系統備份與移轉）
**只接受 API Key 或 sig**。吐出完整 JSON（包含成員名單、進度、徽章履歷、審批等），附帶 `meta.sha256` 雜湊校驗碼。
- 預設（`include_hash: false`）：剝除密碼雜湊，供標準備份。
- 移轉模式（`include_hash: true`）：保留 `password_hash`、`salt`、`iterations`，供上層支部直插匯入。

### `upsertUser`（帳號同步與直插匯入）
**只接受 API Key 或 sig**。支援上游轉移使用者，直接插入既有密碼雜湊，使用者照舊密碼登入，毋須重設或強制 `1234 + mustChangePw`。
- 支援 `transferId`：若同一 `transferId` 重複傳入，視為冪等成功放行。
- 防衝突：自動檢查 YMIS 與 Email 唯一性，避免與既有不同帳戶相撞。
- **經旅系統 sig 推送嘅鏡像（`upsertUser`）及選單「📥 匯入 JSON」嘅寫入更嚴格**：只收 64 位 hex `password_hash`；帶明文 `password`、假 hash、新帳戶冇 hash 一律拒；冇帶 hash 時保留原密碼。詳見 Git 內 `operations/TROOP_LINK_UPGRADE.md`（維運文件，不部署）。

### `setPw` / `verifyPw` / `setStatus`（伺服器對伺服器帳號維護）
- `setPw`：上游直接更新成員密碼雜湊。
- `verifyPw`：上游驗證成員密碼是否吻合。
- `setStatus`：更新帳號狀態（`active` / `transferred_out` / `disabled`）。

### 家長只讀 action
`load`（名冊／進度／flat／pending／其他獎章／履歷全部收縮到子女聯集）、
`getOtherBadges`、`getServiceRecords`、`getMembers`（都接受 sig 或 token）。
定向讀（`targetYmis`）唔喺子女聯集 → `code:403`。

---

## normId（防 0082 / 82S 撞號）

`normId(s)`：將純數字 ID pad 到 4 位＋選配大尾字母，其餘原樣（轉大寫）。
例：`82S`→`0082S`、`82`→`0082`、`PROG_0082S`→`PROG_0082S`。
用於 `PORTAL_GLOBAL_ID` 綁定時比對 `childId`。

---

## 上層容器（ecportal／支部／旅）義務

以下**唔屬於 ScoutBadge**，由上層容器負責（本倉只係 leaf 端）：

- 簽發 sig（持有每團 leaf 嘅 API Key）。
- `/api/resolve`（normId 解析，5 分鐘 cache）。
- 家長帳口存儲（旅層）、`PARENT` 身份。
- 中央 SUPER 鑰匙（`EC_SUPER_KEY`）同 atomic backend。
- `03`（atomic merge3）同 `05`（offline staging）—— **本系統暫緩（follow-up）**。

---

## 測試

`npm test` 涵蓋：
- `test/e2e_http.test.js` — 真 dev server＋proxy＋mock GAS（25 項）。
- `test/e2e_realgas.test.js` — **打真 `apps-script/Code.gs`**（vm shim 執行原碼），
  覆蓋 v4.1.0 合約：requireAuth、三種 sig 身份、家長子女聯集收縮、403、
  篡改／過期／錯 key、`getRegistrySafe`、normId、**三點進入並存**、中央登入回打全循環（15 項）。
- `test/troop_upgrade.test.js` — **進度追蹤旅系統升級版回歸測試**（10 項），
  覆蓋前端無關閉按鈕、掣未設定＝開啟、`setDownstreamAccess` 驗簽防護、
  閂口後本地入口一律拒（舊 Portal sig 亦拒）而中央登入（A）照路由（只認票）、上游領袖免 local row、
  `exportAll` JSON 吐出校驗、`upsertUser` 直插密碼與 transferId 冪等、
  `setPw`/`verifyPw`/`setStatus`，以及重開後免 1234 登入。
- `test/troop_link.test.js` — **旅系統（旅 > 團 > 進度）上下游接駁守護測試**（10 項，`npm run test:link`），
  載入真實 `Code.gs` 起上下游兩節點經假網路對打：掣值表（fail closed）、`sig` 數學與防護
  （錯 key／竄改／時窗／重放／混合傳送／白名單）、登記下游、開戶鏡像、匯出匯入搬數、
  `importUsers` 批量、標籤消毒、ABCD 不入工作表、GS 無版號。

> 重要：v4.1.0 合約必須對**真 Code.gs** 做 e2e，唔可以只用 mock backend
> （`test/mock-gas.js` 係假後端，只供快速 proxy 測試；ecportal 歷史證明
> 純 fake-backend 會掩埋整合 bug）。

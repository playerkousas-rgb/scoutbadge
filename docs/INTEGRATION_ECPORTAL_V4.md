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
| 1. 本團密碼登入 | 成員／領袖 | 本地 `Users` 密碼 | **永遠可用**，唔會因上層接入而停用 |
| 2. 上層 sig | 成員／領袖 | 信任鏈 `sig`（免檢） | 上層容器用本團 API Key 簽名，leaf 驗簽後放行 |
| 3. 家長 sig | 家長 | 信任鏈 `sig`（免檢） | 家長只看**自己子女（聯集）**，只讀 |

> **設計決定（對規格嘅有意偏離）**：v4.1.0 `01_AUTH_FINAL` 有「被吃後下級停用
> password 只接受 sig」一句。本系統**不**照辦 —— 本地密碼入口保留，上層 sig 只係
> **多一條免檢入口**，唔係取代本端。理由：上層接入唔應該鎖走本團自己嘅登入。
> 因此 v4.1.0 嘅 `integrated`/`standalone` 整合模式（及 `setIntegrationMode`／
> `getIntegrationMode`／`PORTAL_INTEGRATION_MODE`）在本系統**不设**。

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
  trusted-ticket 路徑（見 `README`／`api/verify-super-ticket.js`）。
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
  篡改／過期／錯 key、`getRegistrySafe`、normId、**三點進入並存**、中央登入全循環（15 項）。

> 重要：v4.1.0 合約必須對**真 Code.gs** 做 e2e，唔可以只用 mock backend
> （`test/mock-gas.js` 係假後端，只供快速 proxy 測試；ecportal 歷史證明
> 純 fake-backend 會掩埋整合 bug）。

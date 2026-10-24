# 部署 /exec 與「旅系統 → 顯示 BACKEND」不一致：調查及處理紀錄（童軍 ScoutBadge）

調查及 ScoutBadge 修正日期：2026-10-24；童軍 GS 版本：`6.1.0`。

> **最終決定：接入資料只提供 API Key；旅團編號在 ADMIN FORM 填寫，不顯示未能確認的部署 URL。**
> 不新增要求用戶貼網址／設定 BACKEND 的步驟，亦不改動內部登入／簽名協定。
> 本文件記錄的是 repository 及程式碼層面的修正；**不代表各旅團的線上 Google 部署已更新**。

## 1. 原因

**舊選單把 `ScriptApp.getService().getUrl()` 當成領袖剛剛選定的部署 URL，但兩者不是同一個資料來源。**

- Google「部署 → 管理部署」視窗顯示的是該視窗中選定的部署入口。
- Sheet 選單執行的是一般函式；程式沒有接收那個部署的 ID，也沒有讀取部署視窗的選擇。
- 同一個 Script 專案可以有多個部署。不能假設 `getUrl()` 就是剛新增／剛選定的那一個。
- 舊版初始化（`initializeSheets()`）也自動讀取同一方法，與選單／舊快取未必相同，所以可能出現第三條網址。

因此，即使領袖「剛部署完成，立即查看」，程式仍未能保證兩條網址相同；不能歸咎於領袖未等夠時間，也不能要求領袖辨認內部部署 ID。

沒有取得這次實際測試的部署清單及執行紀錄，所以尚不能判定另一個 ID 在 Google 內部屬於舊部署、另一個部署還是異常回傳。這不影響停止顯示不可靠 URL 的處理決定。

## 2. 原始碼證據（本次修正前的童軍版）

調查及修正前查閱 `playerkousas-rgb/scoutbadge/main`：commit `c05eed33764718500b5885becc930f2e86f922a1`。

- `apps-script/Code.gs:2890–2905` 的 `menuShowLinkCredentials()`，第 2892 行直接讀：

```javascript
try { url = ScriptApp.getService().getUrl() || ''; }
catch (e) { url = ''; }
```

之後直接當作 BACKEND 顯示（並附「B　BACKEND（部署後抄此 URL）」及「A　隱藏管理鍵」等字眼）。

- `apps-script/Code.gs:513` 的 `initializeSheets()` 亦用同一取值方法，寫入 `scriptUrl` 並顯示於初始化彈窗、回傳到執行結果。

同系其他支部（CUBS 已修正；深資 `vsbadge`、樂行 `roverbadge`）曾有相同直接取值寫法，須各自核實及處理。

**本次僅修改童軍 ScoutBadge repository；沒有修改線上 Google 部署，亦沒有修改深資／樂行 repository。**

## 3. 撤回早前不可靠方案（不採用）

下列說法不是可靠保證，不能再用來指示用戶：

- 部署 ID 長度（例如 56 字元 vs 74 字元）可以判別部署類型或有效性。
- 在 `doGet`／`doPost` 內叫 `getUrl()` 就必然得到實際請求入口。
- 開一次 `/exec` 後就永遠記啱：若來源錯，自動寫入 `WEBAPP_URL` 也會錯；其他請求亦可能覆寫快取。
- `selfUrl` 自報 URL 就是獨立核實：它仍讀回同一來源，屬循環確認。
- 存在 `WEBAPP_URL` 或顯示「✅ 已核實」就可收貨。

## 4. 童軍版實際處理（GS `6.1.0`）

| 位置 | 處理 |
|---|---|
| `initializeSheets()` 彈窗 | 保留完成訊息、建表結果及童軍自己的預設管理員首次登入／改密碼提示；只加「API Key = …」，不提示輸入旅團編號、不顯示自動部署 URL |
| `initializeSheets()` 執行回傳值 | 移除 `scriptUrl`，回傳只有 `success`／`apiKey`／`gsVersion`／`initializedGsVersion` |
| `vercelEnvLines()`／`showVercelEnv()`／`showApiKey()` | 只提供同一隻 API Key（`API Key = …`），不依賴旅團編號、不提供 BACKEND 值；`showApiKey()` 仍回傳純 API Key 字串（原有契約） |
| Sheet 選單「🔗 旅系統」 | 項目改稱「🔑 顯示 API KEY（交 ADMIN）」；保留原有 handler `menuShowLinkCredentials`，舊選單綁定不會失效 |
| 舊 URL 驗證相容函式 | 新增 `verifyBackendUrl()`（固定回 `AUTO_BACKEND_URL_DISABLED`）及 `menuVerifyBackendUrl()`：只提示 Google 部署視窗才是網址來源；不顯示網址、不發請求、不聲稱已核實 |
| `initializeSheets()` 寫入旅團編號 | 不新增；本版從不要求 GS 設定旅團編號，亦不改寫既有 `TROOP_ID`／`TROOP_NAME`／舊 URL 屬性 |
| 舊 URL 快取（`WEBAPP_URL` 等） | 不再讀取來顯示；不擅自刪改既有設定 |
| 前端及文件 | 新增「🌿 系統介紹」分頁及部署教學入口，中英說明同步更新；部署步驟改為「Google 部署視窗提供 URL，自己填 ADMIN FORM」，不新增貼網址到 GS 的設定步驟 |

正式部署網址仍由 Google 部署視窗提供。原有 APP ADMIN 登記及環境變數契約（`TROOP_<編號>_BACKEND`／`_APIKEY`／`_NAME`）、API Key、業務資料、登入／驗票／簽名協定不變。

`Code.gs` 內第 2021／2050／2093 行附近的內部驗票及連線診斷仍會呼叫 `getUrl()`（中央登入票據核對、本機接駁診斷）。這是內部協議的一部分，**本次沒有改寫**；它們不在接入資料顯示路徑，也不會把網址送到前端。不能將「不再顯示網址」當成所有 URL 身分比對風險都已修正。

## 5. 回歸驗收

`test/credential-display.test.js` 覆蓋：

- Google 可能回傳三個不同 URL、同時存在舊 `WEBAPP_URL` 快取時，初始化彈窗、初始化回傳值、`showApiKey()`、`showVercelEnv()`、`vercelEnvLines()`、選單及各 Logger 記錄都不顯示／回傳任何部署 URL。
- 初始化實際彈窗提供原有 API Key，沒有 `scriptUrl`／`backend`，並指示在 ADMIN FORM 填寫編號、名稱、URL 及 API Key。
- 新安裝沒有旅團編號亦可直接生成 API Key；初始化及選單均無編號／網址 prompt，亦不寫入 `TROOP_ID`／`TROOP_NAME`。
- 顯示功能不讀取 Google service URL（`getUrl` 呼叫數為 0）、不探測候選網址（`UrlFetchApp` 呼叫數為 0）、不要求用戶貼網址。
- 重複初始化／查看保留同一 API Key、既有業務紀錄、成員、進度、徽章、履歷、設定及舊屬性原值。
- 新選單標示 API KEY，沒有自動驗證或手動 BACKEND 設定步驟；舊選單相容函式也不顯示網址。
- 中央登入／驗票協議常數（`SUPER_VERIFY_URL`、`SUPER_TOKEN_PREFIX`、`verifyCentralTicket()`）保持不變。

`test/system-intro.test.js` 覆蓋：系統介紹分頁、雙向入口、交叉連結切換、介紹圖（assets／768×1376 WebP／可放大及下載／WebP MIME）、中英鍵齊全、安全邊界文案、無隱藏帳號資訊、部署教學文案。

測試使用本地假資料及 `test/gasvm.js` 模擬器，沒有讀取用戶的線上資料或修改 Google 部署。旅團部署後仍需以更新過的實際 Sheet 介面確認顯示行為。

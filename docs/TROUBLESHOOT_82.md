# 童軍 82 旅「找不到 SHEET」故障排查指南

> 用戶回報：我的系統好像壞了,找不到82的SHEET

這個錯誤通常不是前端程式碼問題，而是 **旅團編號 82 / 0082 的對應、環境變數、或 Google Sheet 缺少工作表** 所致。v2.1 已加入多重修復。

## 快速自檢 (30秒)

1. 開啟：
   - `/api/troops` → 看是否有 `0082`
   - `/api/health?troopId=0082` → `troopFound` 應為 true
   - `/api/health?troopId=82` → 同樣應為 true (已修復 82 ↔ 0082 互通)

2. 若 `troopFound=false`：
   - 檢查 `data/troops.json` 是否有 0082
   - 檢查 Vercel → Settings → Environment Variables 是否有 `TROOP_0082_BACKEND` 或 `TROOP_82_BACKEND`

3. 若後端回 502 / 504：
   - 表示 Apps Script URL 無法訪問
   - 前往 Google Sheet → 擴充功能 → Apps Script → 執行 `diagnoseSheets()` 查看缺失
   - 執行 `initializeSheets()` 修復

## 已修復的問題 (v2.1)

### 1. 82 vs 0082 編號不一致
舊版 `getTroopConfig('0082')` 能找到，但 `getTroopConfig('82')` 在某些環境變數組合下找不到，導致前端顯示「找不到82的SHEET」。

**修復：**
- `api/_registry.js` 新增 `normalizeToPadded4()` 與 `normalizeStripped()`
- 所有變體 `82`, `0082`, `0082` 大小寫都會映射到同一 backend
- `api/troops.js` 去重，只顯示 canonical `0082`
- 前端 `loadTroops()` 與 `selectTroop()` 自動把 `82` 正規化為 `0082`
- `api/proxy.js` 同樣正規化，並在 404 時給出可用旅團列表與排查提示

### 2. `showApiKey()` Bug (ReferenceError: ss is not defined)
舊版 `Code.gs` 中 `showApiKey()` 直接使用未定義變數 `ss` 與 `cfgSheet`，在 Apps Script 編輯器執行會拋錯，導致無法取得 API Key，間接讓人以為 SHEET 壞了。

**修復：**
- 加入 `const ss = getSheet()` 與 `let cfgSheet = ss.getSheetByName('SystemConfig')`
- 即使沒有 Sheet 也能回傳 API Key

### 3. 缺少健康檢查
舊版沒有檢查工作表是否齊全，前端只看到空白或錯誤。

**修復：**
- Apps Script 新增 `REQUIRED_SHEETS`、`diagnoseSheets()`、`repairSheets()`
- `doGet?action=health` / `diagnose` / `checkSheets` 無需驗證即可檢查
- `doPost?action=healthCheck` / `diagnoseSheets` 需 apikey
- `doPost?action=repairSheets` 需管理員權限，一鍵修復所有缺失表
- 新增 `api/health.js` 前端可直接呼叫 `/api/health?troopId=0082`

### 4. 前端誤報「找不到SHEET」
舊版 `loadTroops()` 沒有去重，若同時存在 `82` 與 `0082`，會顯示兩個卡片，點擊 `82` 可能因快取分離而顯示空白。

**修復：**
- 前端自動過濾 `_aliasOf` 項目
- LocalStorage key 使用正規化後的 `0082`，避免 `sc_pending_82` 與 `sc_pending_0082` 分離

## 在 Apps Script 中手動修復步驟

```js
// 1. 檢查
diagnoseSheets()
// 應回傳 {allOk: true}，若 missing 有值，則：

// 2. 修復
initializeSheets()

// 3. 再檢查
diagnoseSheets()

// 4. 取得 API Key
showApiKey()
```

## 在 Vercel 中的修復

設定環境變數：

```
TROOP_0082_BACKEND=https://script.google.com/macros/s/你的ID/exec
TROOP_0082_APIKEY=sc_xxx
```

同時可設 `TROOP_82_BACKEND` 指向同一 URL，v2.1 已自動兼容，無需兩邊都設，但建議以 `0082` 為主。

## 前端測試

```
npm run dev (或 node server.js)
開啟 http://localhost:3000/api/health?troopId=82
應看到
{
  "troopFound": true,
  "normalizedTroopId": "0082",
  "checks": { "normalization_works": true }
}
```

## 若仍顯示找不到

請提供以下資訊給管理員：

1. `/api/troops` 回傳
2. `/api/health?troopId=0082` 回傳
3. 在 Apps Script 執行 `diagnoseSheets()` 的結果截圖
4. 瀏覽器 Console 錯誤 (F12)

通常執行一次 `initializeSheets()` + 重新部署 Apps Script 為「新版本」即可解決。

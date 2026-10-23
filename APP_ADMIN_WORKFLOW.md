# APP 管理工作流程

一個 Vercel Project 可以安全地服務多個旅團，而每個旅團保有自己的 Apps Script deployment、Sheet 與資料。

## 新旅團資料

管理員收到以下資料後，在 Vercel Project 的受保護 Environment Variables 登記：

- 旅團編號（保留前導零）
- 顯示名稱
- 既有 Apps Script `/exec` URL
- 既有 Apps Script API Key

每個旅團正好使用 `TROOP_{ID}_NAME`、`TROOP_{ID}_BACKEND`、`TROOP_{ID}_APIKEY` 三個變數。不要提交這些值到 Git、靜態設定檔、前端或 URL。

## 所有補丁的資料保全硬性規則

**所有前端、API 及 Apps Script 補丁都不得修改用戶現有資料。** 這是每次更新及驗收的硬性功能要求，不是只適用於某一次 GS 版本。

- 不得刪除、覆寫、重置、重新編號或擅自遷移帳號、成員、YMIS、現行及舊 ID 進度、其他徽章、活動履歷、備註和旅團設定。
- 不得因綱要或系統更新而把舊 ID 靜默轉成新 ID，亦不得要求用戶重新輸入已有資料；舊紀錄必須按原值保留。
- 只可作出向後兼容的新增：補建缺失工作表、補齊缺失欄位，以及在設定不存在時加入預設值；**已有值一律不可改寫**。
- 版本及初始化標記只寫入 Apps Script Script Properties，不得借更新標記改寫用戶業務資料；現有 API Key 不得因補丁或重新初始化而更換。
- 補丁驗收必須比較更新前後的用戶資料，證明原有值保持不變；如需要新格式，應新增相容結構並保留原始資料，而不是覆寫。

## 最新版本公告與 GS 初始化核對

- 前端首頁、登入頁及登入後主頁均顯示最新更新日期及最新 GS 版本（不設逐級補丁清單），並提供 `Code.gs` 下載、更新步驟及「重新檢查」按鈕。
- GS 的 `ecStatus`（GET）及登入後 `load` 均回報 `gsVersion` 和 `initializedGsVersion`。
- `initializeSheets()` 成功完成後，才在 Script Properties 寫入 `INITIALIZED_GS_VERSION`。
- 前端分辨三種狀態：「GS 未更新」、「GS 已更新但未初始化」、「全部完成」；只有最後一種情況才顯示綠色「已核對」。
- 如該版本需要初始化，公告明確寫出「必須執行一次 `initializeSheets()`」。

## 操作步驟

1. 在 Vercel 設定三個完整變數。
2. 重新部署同一個 Project。
3. 確認 `/api/troops` 僅顯示編號及名稱。
4. 用該旅團既有帳號進行讀寫、審批和跨旅團隔離測試。

`0082` 與 `82` 是不同旅團識別字；不要以別名、補零或共用設定來混合它們。

## Portal

保留 `PORTAL_DEFAULT_ORIGIN`、`PORTAL_DEFAULT_ROLES` 與各旅團的 Portal 覆蓋設定。這些設定只控制整合範圍；URL 或角色參數不是可靠的身份驗證，不能代替伺服器授權。

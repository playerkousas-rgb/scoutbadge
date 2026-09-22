# Apps Script 維護紀錄

版號、歷史更新及開發背景集中保留在 Git，不放入可下載的 GS 或用戶提示。
本文件不納入網站部署：`build.js` 只發布本目錄的 `Code.gs`，`.vercelignore` 亦排除其餘檔案。

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

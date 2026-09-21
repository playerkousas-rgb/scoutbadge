# 部署瘦身與資產原則

本專案以「不犧牲既有功能、邏輯、UI 與使用者體驗」為前提控制部署內容。

## 部署範圍

- 只部署執行所需的靜態頁面、資料、前端資產、`api/` 端點及其 server-side library。
- 公開靜態目錄是 `public/`，由 `npm run build`（`build.js`）產生，只複製 `index.html`、`assets/`、`data/`、`docs/`，以及 `apps-script/Code.gs`（開團步驟 1「⬇️ 下載 Code.gs (最新)」的官方下載檔，本來就是設計給領袖下載的）；`vercel.json` 的 `outputDirectory` 固定為 `public`。`public/` 是產物，不提交到 Git。
- `api/` 與 `lib/` 留在專案根目錄：`api/` 由 Vercel 建立 Functions，`lib/` 被各 Function bundle，兩者都不會被靜態服務，因此 server-side 原始碼不會公開下載。
- `build.js` 會核對 `index.html` 引用的本機路徑。未發布的路徑必須在 `KNOWN_UNDEPLOYED` 列明原因，否則建置失敗，避免新資產在 production 靜默 404。
- `.vercelignore` 排除 Git 資料、依賴目錄、測試、備份、log、暫存、上載目錄與文件；`apps-script/` 內除 `Code.gs`（官方下載檔）以外的內容不會上載。
- Server-side helper 放在 `lib/`，不放成公開 API 路由。
- 依賴維持極簡；建置或測試工具應列為 `devDependencies`。新增執行期依賴前，先確認原生平台功能不能完成同一工作。

## 刪除檔案前

1. 全文搜尋檔名、動態路徑、下載連結和 fallback。
2. 檢查 MOCK、測試及匯入流程是否真的不再需要該檔案；名稱包含 `mock` 或 `test` 不代表可刪除。
3. 刪除後執行 lint／測試／建置，並以實際介面驗證。

移除目前檔案只能減少之後的部署內容；不能宣稱會清除 Git 歷史、舊部署或 Vercel 歷史配額。

## 圖片原則

- 先保留畫質、透明度、版面尺寸、快取行為與目標瀏覽器相容性。
- 可評估 AVIF，但必須有相容策略；計算 AVIF 與 fallback 的總容量，而非只看單一檔案。
- 只有在所有引用、動態載入與下載用途確認為未使用後，才移除圖片。
- 以實際視覺比對及載入大小驗收壓縮或格式轉換，不能因檔名或預期用途而犧牲顯示品質。

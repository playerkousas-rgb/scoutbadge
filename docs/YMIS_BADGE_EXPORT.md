# YMIS 獎章匯出（試行）

> 童軍支部版，由 CUBSBADGE 的同名功能移植。**試行版：尚無真實資料在 YMIS 驗證，匯出不等於匯入成功。**
> 相關文件：[LEADER_GUIDE.md](LEADER_GUIDE.md)（領袖教學）、[SCOUT_ID_EXPORT.md](SCOUT_ID_EXPORT.md)（由 YMIS 匯出 SCOUT ID 名單，方向相反）。

領袖登入後，在「👥 全團總覽」按「⬇️ 匯出 YMIS 獎章（試行）」。成員帳號看不到這個入口。
不需更新 Apps Script，亦不需重新執行 `initializeSheets()`；整個流程只在瀏覽器內進行，不會呼叫旅團後端。

## 步驟

1. 選擇一款**已正式頒發**的獎章。
2. 勾選獲頒的成員，逐人填寫**實際獲獎日期**（沒有預設日期）。
3. 核對成員 SCOUT ID、獎章、日期及 YMIS 現有紀錄，勾選確認。
4. 按「⬇️ 下載 XLSX」，得到 `YMIS-badges-YYYY-MM-DD.xlsx`。
5. 登入 YMIS → **成員註冊 → 資料檔案上傳 → 新增支部獎章紀錄**，上傳並按系統指示確認。不要選完整青少年成員登記。

每次匯出一款獎章、多位成員；其他獎章另行匯出。未勾選的成員不會輸出。

## 這個功能不會做的事

- **不會把考核完成視作已頒章。** 獎章與日期全部由領袖明確指定，不讀取、亦不參考本系統的考核進度。
- **不會更改 SCOUTBADGE 的任何進度或紀錄**，也不會記低匯出過什麼。
- 選取狀態只在這次視窗內保留；關閉視窗或重新整理後需重新輸入。
- 沒有跨次匯出／YMIS 重複偵測：同一檔案上傳兩次、或 YMIS 已有該紀錄，本系統都不會知道。

## 檔案格式

四欄（依使用者提供的 YMIS 範本，欄名及次序逐字一致），工作表名 `Sheet1`：

`Scout ID`, `Badge-Section`, `Badge-Badge`, `Badge-award date (YYYYMMDD)`

| 欄 | 內容 |
|---|---|
| `Scout ID` | 成員的 SCOUT ID：10 位數字，以文字儲存以保留前導零。不是 10 位數字的成員不能勾選。 |
| `Badge-Section` | 固定 `Scout`。 |
| `Badge-Badge` | 下表五款其中之一。 |
| `Badge-award date (YYYYMMDD)` | 領袖填寫的實際獲獎日期，例如 `20261114`，以文字儲存。 |

| 本系統獎章 | `Badge-Badge` 值 |
|---|---|
| 會員章 | `Membership Badge` |
| 童軍探索獎章 | `Scout Pathfinder Award` |
| 童軍標準獎章 | `Scout Standard Award` |
| 童軍高級獎章 | `Scout Advanced Award` |
| 總領袖獎章 | `Chief Scout's Award` |

不包含：專科徽章（興趣／技能／服務／教導組）、海上及航空活動徽章、其他獎章、考核細項、2017 制過渡等同紀錄（`LEGACY-2017-*`），亦沒有範本示例行。

## 驗證界線

本地測試（`test/ymis-export.test.cjs`）涵蓋欄名、獎章對應、日期、編號、重複行及工作表資料。
**尚無真實資料在 YMIS 驗證**，不保證其伺服器接受這個檔案；這不是官方 API 串接，也不會自動得知上傳結果。**匯出不等於匯入成功。**

- 五個 `Badge-Badge` 值按使用者提供的童軍支部字串逐字寫入。
- `Badge-Section` 的 `Scout` 是按幼童軍支部範本的 `Cub Scout` 類推，**尚未對照童軍支部範本**；若 YMIS 拒絕支部一欄，請回報實際寫法。

首次使用建議先上傳**一筆**真實而未登記的紀錄，在 YMIS 確認結果後才批量使用。若出錯，請經 APP 的「回報 · 意見」提供錯誤文字或遮蓋個人資料的截圖；不要提交含真實成員編號的完整檔案。

下載的檔案含個人識別資料（成員編號），請妥善保管，用完即刪。

## 技術備註

- 對應表與驗證邏輯：[`assets/ymis-export.js`](../assets/ymis-export.js)（瀏覽器 `window.YmisExport`／Node `require`）。
- Excel 由 SheetJS `xlsx@0.18.5` 產生。只在領袖開啟匯出視窗時才從 CDN 載入（cdnjs → jsDelivr → unpkg），並以 SRI 雜湊固定檔案內容；載入失敗時視窗會提示，可檢查網絡後再按下載。
- 要修改獎章字串，只改 `assets/ymis-export.js` 的 `badges`／`section`，並同步更新本文件及測試。

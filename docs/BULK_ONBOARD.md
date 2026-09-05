# 批量開戶（Bulk Onboarding）

一次過為整團開立多名成員 / 帳號，不用逐個填表。

## 四種開戶方式定位

| 方式 | 定位 | 說明 |
|---|---|---|
| ⓪ 領袖上載 YMIS 自訂報表 PDF（APP 內「📥 批量開戶」） | **批量開戶主路（最推薦）** | YMIS 匯出 → 上載（支援密碼解鎖）→ 預覽 → 一鍵開戶，見 [`YMIS_EXPORT.md`](YMIS_EXPORT.md) |
| ① 後端 Sheet 直接寫（本文件 Apps Script） | **進階／備用，日常不建議** | 特殊情況或無前端權限時使用 |
| ② 前端自行申請 → 領袖前端審批 | 個人開戶主路 | APP 內「🆕 申請成員帳戶」，領袖於「審批中心」批准 |
| ③ 領袖前端上傳批量範本（APP 內「📥 批量開戶」） | 批量開戶備路 | 下載範本 → 前端上傳 → APP 轉 JSON 寫入後端 |

> 設計原則：所有開戶盡量在前端完成。方法①僅作備用。

## 方法零：YMIS 自訂報表 PDF 直接匯入（最推薦）

```
YMIS 自訂報表（編號→中文姓名→電郵）──► 下載 PDF ──► APP 上載（可輸入密碼）──► 預覽/修正 ──► 批量開戶
```

1. 在 YMIS 匯出自訂報表，欄位**必須依序**為：**童軍成員編號 → 中文姓名 → 電郵地址**。
2. APP → 👥 用戶管理 → **📥 批量開戶** → 輸入 PDF 密碼（如有）→ **📄 上載 YMIS PDF 報表**。
3. 檢查預覽表（YMIS／姓名／電郵可即場修改，已存在的成員自動不勾）。
4. 設定預設小隊、角色、初始密碼（留空＝只加入名單，不開登入帳號）。
5. 按 **🚀 確認批量開戶**。

PDF 解密在瀏覽器內以 `pdf.js` 完成，檔案與密碼都不會上傳伺服器。
讀不到時可改用「🔍 解析貼上的文字」，或先用 Chrome／Edge 列印為無密碼 PDF。
完整步驟、密碼處理與疑難排解見 [`YMIS_EXPORT.md`](YMIS_EXPORT.md)。

## 流程總覽

```
下載範本 CSV ──► 填寫 ──► 轉為 JSON ──► 寫入我們的 Sheet（Google Sheet）
```

「我們的 Sheet」即 app 後端所用的 Google Sheet，成員存放在名為 **`Users`** 的工作表，
其欄位結構與 app 後端完全一致：

```
ymis, name, email, role, password_hash, branch, can_tick, auth_by,
auth_date, created_at, last_login, status, allowed_badges, squad, squad_role, force_change_password
```

## 方法一：在 APP 內直接上傳 CSV（自行填寫時最快）

1. 登入 APP → 進入「👥 用戶管理」。
2. 按 **📥 批量開戶** → **⬇️ 下載成員範本 CSV**（`data/members_template.csv`）。
3. 在試算表軟件打開，填寫每位成員的資料。
4. 回到對話框，按 **📥 上傳填好的 CSV**，系統會自動為每位成員開戶。
   - 有填 `password` → 開立可登入帳號（`addUser`，密碼以 SHA-256 雜湊儲存）。
   - 只填 `ymis` + `name` → 只加入成員（`addMember`，不可登入）。
5. 亦可把 JSON 陣列貼到文字框，按 **🚀 由 JSON 批量開戶**。

### 範本欄位（CSV）

| 欄位 | 說明 |
|---|---|
| ymis | 10 位數字（必填，作為帳號） |
| name | 姓名（必填） |
| email | 電郵（開帳號時建議填） |
| squad | 小隊名稱 |
| squad_role | member / 隊長 / 副隊長 |
| role | member / branch_leader / group_leader / admin |
| can_tick | true / false（可否勾選進度） |
| password | 有填則開立可登入帳號 |
| note | 備註（僅提醒用，不寫入 Users 工作表） |

## 方法二：Google Sheets + Apps Script（符合「SAMPLE → JSON → 寫入 SHEET」）

適合直接在 Google Sheets 操作，資料在試算表內轉 JSON 並直接寫入我們的 Sheet。

1. 在 Google Sheets 新建試算表。
2. **檔案 > 匯入 > 上載 > 選取本機 CSV**，選 `data/members_template.csv`（或從 app 下載的同一份）。
3. 填寫資料。
4. **擴充套件 > Apps Script**，把 [`assets/batch-onboard/Code.gs`](assets/batch-onboard/Code.gs) 的內容貼上並儲存。
5. 修改檔首 `CONFIG`：
   - `MAIN_SHEET_ID`：我們的 Sheet 的 ID（直接寫入時需要，出現在網址 `/d/.../` 之間）。
   - `APIKEY`：與 app 登入相同的 apikey（用「推送後端」時需要）。
   - `BACKEND_URL`：你 app 的 doPost 部署網址（用「推送後端」時需要）。
   - `USERS_SHEET`：主資料表內成員工作表名稱，預設 `Users`。
6. 回到試算表，重新整理，出現 **批量開戶** 選單：
   - **✍️ 直接寫入主資料表**：直接 append 到我們的 Sheet 的 `Users` 工作表（依 ymis 跳過重複）。
   - **📤 轉JSON並推送後端**：逐列 POST 到 app 後端 `addMember` / `addUser`。
   - **📝 預覽JSON**：先檢查將轉出的 JSON。

### 全新 Sheet 也可以！（自動建表）

直接寫入支援**全新、完全空白的 Sheet**：

- 若 `Users` 工作表不存在 → 自動建立。
- 若 `Users` 工作表沒有 `ymis` 表頭（空白新表）→ 自動寫入標準 16 欄表頭。
- 有填 `password` 的成員會以 SHA-256 雜湊儲存密碼，開戶後即可登入（建議首次登入修改密碼）。

> 提示：若你想要這份 Sheet 完全由 app 使用（含進度追蹤、操作紀錄等其他工作表），
> 請先執行 app 後端的 `initializeSheets()` 一次性建立所有工作表，再執行批量開戶。

## 預設密碼與團長鎖

- 批核／開戶若未指定密碼，預設初始密碼為 **1234**，首次登入必須更改（最少 4 位）。
- 領袖可留空 YMIS，以電郵登入；系統內部編號 `L0001` 起不對外顯示。
- 全團只可有一位團長；支部領袖不可開立 admin／團長／其他支部領袖。
- `branch_leader` 不可建立 `admin` / `group_leader` / `branch_leader`。

## 注意

- YMIS 必須為 10 位數字，否則該列會被忽略。
- 已存在的 YMIS 會被跳過（不覆蓋）。
- 直接寫入時密碼會以雜湊形式儲存，與 app 後端登入機制一致。
- 批量操作建議先以小量（2–3 筆）測試，確認無誤再全團匯入。

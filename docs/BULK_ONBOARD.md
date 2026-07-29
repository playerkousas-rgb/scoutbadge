# 批量開戶（Bulk Onboarding）

一次過為整團開立多名成員 / 帳號，不用逐個填表。

## 三種開戶方式定位

| 方式 | 定位 | 說明 |
|---|---|---|
| ① 後端 Sheet 直接寫（本文件 Apps Script） | **進階／備用，日常不建議** | 特殊情況或無前端權限時使用 |
| ② 前端自行申請 → 領袖前端審批 | 個人開戶主路 | APP 內「🆕 申請成員帳戶」，領袖於「審批中心」批准 |
| ③ 領袖前端上傳批量範本（APP 內「📥 批量開戶」） | **批量開戶主路（推薦）** | 下載範本 → 前端上傳 → APP 轉 JSON 寫入後端 |

> 設計原則：所有開戶盡量在前端完成。方法①僅作備用。

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

## 方法一：在 APP 內直接上傳 CSV（最快）

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

## 注意

- YMIS 必須為 10 位數字，否則該列會被忽略。
- 已存在的 YMIS 會被跳過（不覆蓋）。
- 直接寫入時密碼會以雜湊形式儲存，與 app 後端登入機制一致。
- 批量操作建議先以小量（2–3 筆）測試，確認無誤再全團匯入。

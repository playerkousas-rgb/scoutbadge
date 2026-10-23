# 👨‍💼 領袖使用教學 (Leader Guide)

> 給領袖的說明：你擁有全部權限（考核、審批、用戶管理）。
> APP 內 ❓ 教學也有同一份內容（會跟隨介面語言顯示中／英文版）。
> 相關文件：[YMIS_EXPORT.md](YMIS_EXPORT.md)（YMIS 匯出教學）、[BULK_ONBOARD.md](BULK_ONBOARD.md)（批量開戶總覽）。
>
> 🆕 **新部署旅團第一次登入**：預設管理員帳號係 YMIS `1111111111`／密碼 `changeme`
> （用「👤 成員」分頁以 YMIS 登入，首次登入會強制改密碼）。
> 完整步驟見 [TROOP_ONBOARDING.md](../TROOP_ONBOARDING.md) §C「首次登入（預設管理員帳號）」。

---

## 最新更新公告（2026-10-23）

> **所有補丁的硬性資料保全規則：不得修改、刪除、覆寫、重置或擅自遷移用戶現有資料。** 帳號、成員、YMIS、現行及舊 ID 進度、其他徽章、活動履歷、備註和旅團設定都包括在內；舊資料不得因版本更新而被轉換或要求重新輸入。補丁只可向後兼容地補齊缺失結構，已有值一律保留。完整部署規則見 [APP_ADMIN_WORKFLOW.md](../APP_ADMIN_WORKFLOW.md)。

- **最新 GS：`6.0.0`**。只需安裝這個最新版，無須逐級下載補丁。
- **這次必須執行一次 `initializeSheets()`**。更新步驟：下載並取代 `Code.gs` → 儲存 → 執行 `initializeSheets()` → 管理部署 → 編輯現有部署 → 選「新版本」→ 部署（沿用原 URL）。
- 首頁、登入頁及登入後主頁都會顯示最新日期、GS 版本及下載入口。系統會分別核對 **GS 程式版本**及**初始化版本**：只貼新程式但未初始化，仍會顯示警告；綠色「已核對」才代表兩者都完成。
- 初始化只補齊缺失的設定及工作表，並在 Script Properties 記錄版本；不得更改上述用戶資料，亦不應更換現有 API Key。完成後在公告按「重新檢查」。

---

## 1. 我的進度

- 選任何成員查看所有紀錄。
- 直接勾選＋日期；寫入會先**離線暫存**，確認後一次寫入。

## 2. 全團總覽

- 卡片一眼看到會員章 ✓。
- 表格矩陣最多 30 欄。
- 🚀 **考驗營批量**：選成員＋選項目 → 一鍵標記 → 暫存 → 確認寫入。
- 子切換：按成員／按項目。

## 3. 審批中心

- 🏅 獎章審批＋👤 用戶審批合併在同一頁。
- v5.2 起「📅 履歷申報」（成員自行申報的活動履歷）也在這裡批准／拒絕。
- 審批開戶時會顯示臨時密碼（首次登入須更改）。

## 4. 📅 活動履歷（v5.0 新增；v5.2 加入成員申報）

- 領袖可為成員記錄**服務、活動、訓練班**三類活動，支援批量、編輯、刪除。
- v5.2 起成員可在「📅 活動履歷」按「📝 申報紀錄」自行申報；領袖在「✅ 審批中心 → 📅 履歷申報」批准／拒絕。
- 成員對已批紀錄按 ✏️ 可提交「修改申報」，批准後以**同一紀錄**更新（重批機制）；批准前成員可取消。
- 進度獎章、其他獎章流程不變：批了只有領袖可改。
- 後端需升級至 v5.2（覆蓋 [Code.gs](../apps-script/Code.gs) 後執行 `initializeSheets()` 補建「待批履歷」表）。

## 5. 表格列印

- 自動填入成員資料與進度日期，官方 PT/18、P120A1 童軍支部表格格式，可編輯後列印。

## 6. 用戶管理

- 更改成員角色、停用／刪除帳戶；可直接為成員設定新密碼（無電郵也可面對面告知）。
- ⚙️ **權限設定**：領袖預設全部 (*)，可按個別成員設定可考核範圍。
- 🆕 成員／領袖可自行申請帳戶，在「審批中心」批准；旅長／管理員須由現任管理層直接開立。

## 7. 📥 批量開戶（YMIS 報表匯入）

用戶管理 → **📥 批量開戶**，最快是直接上載 YMIS 匯出的「自訂報表」PDF：

1. 登入 [YMIS](https://ymis.scout.org.hk/#/private/MemberSearch) → 功能 → 搜尋成員紀錄。
2. 展開「成員紀錄」，選地域、童軍區，「童軍旅」輸入你的旅團代號 → 按「搜尋」。
3. 勾選成員（或最上方「全選」）→ 按「編製報告」。
4. 報告種類選「自訂報表」；「排列／第二排列」可不變。
5. **嚴格依序**把左側欄位加到右側：①童軍成員編號 ②中文姓名 ③電郵地址（次序＝加入次序，寬度可維持 100%）。
6. 按「確定」下載 PDF。
7. 回到 APP：輸入 PDF 密碼（如有）→ 上載 PDF → 檢查預覽（可即場修改 YMIS／姓名／電郵）→ 設定預設小隊、角色、初始密碼 → 按「🚀 確認批量開戶」。

🔐 若 PDF 密碼解不開：用 Chrome／Edge 打開 PDF（輸入一次密碼）→ 列印 → 目的地「另存為 PDF」，新檔案就沒有密碼；亦可把報表文字複製，用「貼上文字」解析。
詳細步驟、欄位對照與疑難排解見 [YMIS_EXPORT.md](YMIS_EXPORT.md)；其他開戶方式（CSV 範本、Sheets 直接寫入）見 [BULK_ONBOARD.md](BULK_ONBOARD.md)。

## 8. 系統設定（旅長）

- **允許成員互相查看進度**：預設關，旅長可開。
- **允許成員提交完成申請**：預設開，旅長可關（關閉後成員不能提交申請，需領袖直接剔）。

---

## English Version

> As a leader you have full permissions (assessment, approvals, user management).
> See also: [YMIS_EXPORT.md](YMIS_EXPORT.md) and [BULK_ONBOARD.md](BULK_ONBOARD.md).

### Latest update (2026-10-23)

> **Hard data-preservation rule for all patches: never modify, delete, overwrite, reset, or arbitrarily migrate existing user data.** Accounts, members, YMIS, current and legacy-ID progress, other badges, activity records, notes and troop settings are all covered; old data must not be converted or re-entered due to a version update. Patches may only add backward-compatible structures; existing values are always preserved. Full deployment rules: [APP_ADMIN_WORKFLOW.md](../APP_ADMIN_WORKFLOW.md).

- **Latest GS: `6.0.0`**. Install this latest version only — no per-version patch list.
- **This release requires running `initializeSheets()` once.** Update steps: download and replace `Code.gs` → save → run `initializeSheets()` → deploy → manage deployments → edit → new version → deploy (URL stays the same).
- The home, login and main views all show the latest date, GS version and download link. The system checks **GS code version** and **initialization version** separately: pasting new code without initializing still shows a warning; the green "Verified" only appears when both match.
- Initialization only fills in missing settings and sheets, and records the version in Script Properties; it must not change any of the above user data, nor rotate the existing API key. After completion, press "Re-check" in the notice.

### 1. My Progress

- Select any member to view all records.
- Tick directly with a date — saved offline first, then confirm to write.

### 2. Troop Overview

- Cards show the Membership Badge ✓ at a glance.
- Matrix table up to 30 columns.
- 🚀 Assessment camp batch: pick members + items → one-tap mark → staged → confirm.
- Sub-views: by member / by item.

### 3. Approval Centre

- 🏅 Badge approvals + 👤 user approvals combined on one page.
- From v5.2, "📅 Log claims" (member self-declared activity records) are approved/rejected here too.

### 4. 📅 Activity Log (v5.0; member claims added in v5.2)

- Leaders record **service, activities and training courses** for members, with batch / edit / delete.
- From v5.2, members tap "📝 Claim a record" in "📅 Activity Log"; leaders approve/reject under "✅ Approval Centre → 📅 Log claims".
- Members can tap ✏️ on an approved own record to submit an edit claim; on approval it updates the SAME record (re-approval flow); members may cancel while pending.
- Progressive badges and other awards are unchanged: once approved, only leaders may change them.
- Backend must be on v5.2 (overwrite [Code.gs](../apps-script/Code.gs), then run `initializeSheets()` to create the "待批履歷" sheet).

### 5. Forms

- Auto-filled with member data and progress dates in the official Scout Section PT/18 / P120A1 format; edit then print.

### 6. User Management

- Change roles, deactivate/delete accounts; set a member's new password directly (can be told face-to-face without email).
- ⚙️ Permission settings: leaders default to all (*); per-member assessable scope can be set.
- 🆕 Members and leaders may apply for accounts themselves, approved in the Approval Centre; Group Leader / admin accounts must be created directly by the current management.

### 7. 📥 Bulk onboarding (import the YMIS report)

User Management → **📥 Bulk onboarding**. The fastest route is uploading the YMIS "Custom Report" PDF:

1. Sign in to [YMIS](https://ymis.scout.org.hk/#/private/MemberSearch) → Function → Search Member Record.
2. Expand "Member Record", choose Region and District, type your group number in "Scout Group" → Search.
3. Tick the members (or "Select All") → click "Generate Report".
4. Report type: "Custom Report"; sort options can stay unchanged.
5. Add fields to the right in **exactly** this order: ① Scout Member No. ② Chinese Name ③ Email Address (order = the order you add them; widths can stay at 100%).
6. Click "Confirm" to download the PDF.
7. Back in the app: type the PDF password (if any) → upload the PDF → review the preview (YMIS / name / email are editable) → set default patrol, role and initial password → "🚀 Confirm bulk onboarding".

🔐 If the password cannot be unlocked: open the PDF in Chrome/Edge (enter the password once) → Print → "Save as PDF"; the new file is unencrypted. You can also copy the report text and use "Parse pasted text". See [YMIS_EXPORT.md](YMIS_EXPORT.md) for the full walkthrough and [BULK_ONBOARD.md](BULK_ONBOARD.md) for other onboarding routes (CSV template, direct Sheets write).

### 8. System Settings (Group Leader)

- **Allow members to view each other's progress**: off by default, Group Leader may enable.
- **Allow members to submit completion requests**: on by default, Group Leader may disable (members then cannot submit; leaders tick directly).

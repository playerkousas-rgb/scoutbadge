# 👤 成員使用教學 (Member Guide)

> 給團員的說明：你只需關心自己的進度，其他功能由領袖處理。
> APP 內 ❓ 教學也有同一份內容（會跟隨介面語言顯示中／英文版）。

---

## 一、登入

1. 首頁點擊你的旅團卡片（例如 **0082 第82旅**）。
2. 登入方式：
   - **成員**：YMIS 10 位數字 + 密碼。
   - **領袖**：電郵 + 密碼（領袖毋須 YMIS）。
3. 沒有帳戶？在登入頁按「🆕 申請帳戶」，填妥後由領袖在「審批中心」批准。
   批核後**初始密碼為 1234**，首次登入時系統會**強制要求設定新密碼**（至少 4 位）。
   忘記密碼請聯絡領袖／管理員重設。

---

## 二、登入後你會見到

| 分頁 | 用途 |
|---|---|
| **📊 我的進度** | 預設只顯示你自己的完成度：綠色進度條＝已完成。點擊獎章展開，右側 **ⓘ** 查看考驗說明。**不能直接剔**，只能按「📝 申請完成」。 |
| **⭐ 其他獎章** | 已併入「我的進度」最底虛線卡片。 |
| **📅 活動履歷** | 查看你的服務／活動／訓練班紀錄；可按「📝 申報紀錄」自行申報（v5.2 起，需領袖批准才寫入）。 |
| **📝 待批** | 查看你提交的申請（進度申請＋履歷申報）是否已批，待批中可自行取消。 |
| **🖨️ 表格列印** | 自動填入童軍支部進度日期，可編輯後列印官方格式（PT/18、PT/120A 等）。 |
| **📚 資料庫** | 保護兒童課程連結、訓練綱要。 |

---

## 三、如何申請完成？

1. 在「📊 我的進度」找到項目。
2. 按 **📝 申請**。
3. 選日期＋證據。
4. 提交，領袖在「待批」看到。
5. 批准後進度更新。

> 注意：進度獎章、其他獎章「**批了不能改**」，只有領袖可改；只有活動履歷可以自行申報修改。

---

## 四、如何申報活動履歷？（v5.2 新增）

1. 「📅 活動履歷」按「📝 申報紀錄」。
2. 填類型、日期、名稱（服務可填時數、訓練班可填證書編號）。
3. 提交後進入「待領袖審批」，**可自行取消**。
4. 領袖批准後才寫入活動履歷。
5. 已批准的紀錄要改？按 **✏️** 提交「修改申報」，領袖重批後以**同一紀錄**更新。

---

## 五、常見問題

**為何看不到其他成員？**
預設私隱，成員只看自己。團長可在用戶管理開啟「允許成員互相查看進度」。

**「📅 活動履歷」找不到／顯示升級提示？**
代表旅團後端還未更新至 v5.2 表格結構，可請領袖通知管理員更新 [Code.gs](../apps-script/Code.gs) 並執行 `initializeSheets()`。

---

## English Version

> As a member you only need to track your own progress; leaders handle the rest.

### Signing in

1. Tap your troop card on the home page (e.g. **0082**).
2. **Members** sign in with their 10-digit YMIS number + password; **leaders** use email + password.
3. No account yet? Use "🆕 Apply for an account" on the login page; a leader approves it in the Approval Centre. The initial password is **1234**; on first login you are **required to set a new one** (at least 4 characters).

### After login you will see

- **📊 My Progress** — shows only your own completion by default. Green bar = completed. Click a badge to expand and tap ⓘ for assessment details. **You cannot tick directly** — use "📝 Apply for completion".
- **⭐ Other Badges** — merged into the dashed card at the bottom of My Progress.
- **📅 Activity Log** — your service / activity / training course records; tap "📝 Claim a record" to self-declare (from v5.2, written only after a leader approves).
- **📝 Pending** — check your requests (progress claims + log claims); you may cancel them while pending.
- **🖨️ Forms** — auto-filled with your progress dates; edit then print in the official format (PT/18, PT/120A).
- **📚 Library** — Safe from Harm course links and the training scheme.

### How to apply for completion?

1. Find the item in My Progress.
2. Tap 📝 Apply.
3. Pick a date + evidence.
4. Submit — leaders see it under Pending.
5. Once approved, your progress updates.

### How do I claim an activity-log record? (new in v5.2)

1. In "📅 Activity Log", tap "📝 Claim a record".
2. Fill type, date and title (service hours / course certificate no. where applicable).
3. After submitting it shows "awaiting a leader" and you may cancel it.
4. It appears in the activity log only once a leader approves.
5. Need to change an approved record? Tap ✏️ to submit an edit claim — it updates in place after a leader re-approves.

### FAQ

**Why can't I see other members?**
Privacy by default: members only see themselves. A Group Leader can enable "allow members to view each other's progress" in User Management.

**Can't find the Activity Log / an upgrade notice is shown?**
The troop backend has not been updated to the v5.2 sheet structure — ask a leader to have the admin update [Code.gs](../apps-script/Code.gs) and run `initializeSheets()`.

**Note:** progressive badges and other awards stay "locked after approval" — only leaders may change those; only the activity log can be self-claimed and edit-claimed.

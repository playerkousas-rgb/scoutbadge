# 🔑 忘記密碼與重設指引 (Password Reset Guide)

> 本系統只設**三條找回密碼路徑**（按帳戶類別區分），不設第四種方式：
>
> 1. **童軍成員（無登記電郵）** → 搵本旅團領袖在後台「👥 用戶管理 → 重設密碼」重發臨時密碼
> 2. **領袖／已登記電郵帳戶** → 在登入頁按「🔑 忘記密碼？」收取 **8 位重設碼**自助重設
> 3. **旅團預設管理員（`1111111111`）** → 按「🐛💬 回報 · 意見」聯絡**主系統管理員（APP ADMIN）**協助重設

---

## 一、領袖自助重設密碼（已登記電郵帳戶）

1. 在首頁揀選你的旅團卡片，進入登入頁。
2. 按密碼欄旁邊顯眼的 **「🔑 忘記密碼？」** 按鈕。
3. **第 1 步（索取重設碼）**：
   - 在單一輸入欄填寫你的 **童軍編號（YMIS）** 或 **登記電郵**（二選一即可）。
   - 按 **「📨 發送 8 位重設碼」**。
   - 為保護帳戶私隱，無論帳號是否存在，畫面都會顯示同一句提示：「若此帳號已登記電郵，重設碼已發送到登記電郵（15 分鐘內有效）。」
4. **第 2 步（輸入重設碼並設定新密碼）**：
   - 打開登記電郵信箱，找到標題含「`【童軍進度追蹤】忘記密碼重設碼`」的電郵。
   - 複製信內 **8 位重設碼**（例如 `ABCD-1234`），貼入重設碼欄——系統**不分大小寫**，並會**自動去除空格及連字號（`-`）**。
   - 輸入 **4–32 位新密碼** 並再次確認，按 **「✅ 確認重設密碼」**。
5. **完成登入**：
   - 重設成功後，該帳號在所有舊手機／電腦的登入狀態會**即時全部登出**，並自動清除連續輸錯密碼鎖定。
   - 畫面自動返回登入頁並預填帳號，直接用剛設定的新密碼（4–32 位）登入即可。

### 📬 收唔到重設電郵？逐步排查

1. **檢查垃圾郵件／促銷匣**：信件由旅團 Google 帳戶自動寄出，首次收信可能被歸入 Spam／Junk。
2. **確認帳戶是否已登記真實電郵**：未登記電郵的童軍成員不會收到電郵，請直接搵本旅團領袖重設。預設管理員 `1111111111` 使用佔位電郵 `admin@example.com`，同樣不會寄信。
3. **重設碼過期或輸錯太多次**：每組重設碼 **15 分鐘內有效**，最多可嘗試 **5 次**；重新索取新碼會即時作廢舊碼（每帳號每 30 分鐘最多索取 3 次）。
4. **全團領袖都收唔到信（旅團管理員檢查）**：代表更新 `Code.gs` 後尚未完成 Google 電郵寄送授權。請旅團管理員開啟試算表 →「擴充功能 → Apps Script」，在上方函式選單揀 `testPasswordResetMail` 並按「執行」，完成 Google 授權並收到測試信即可恢復正常。

---

## 二、童軍成員忘記密碼（無登記電郵）

1. 向本旅團領袖／團長提出重設密碼。
2. 領袖登入後進入 **「👥 用戶管理」**，在該成員一列按 **「重設密碼」**：
   - 可輸入自訂臨時密碼（4–32 位），或留空使用預設臨時密碼 `1234`。
3. 系統會即時：
   - 清除該成員的登入失敗鎖定紀錄；
   - 踢走該成員所有舊裝置登入狀態；
   - 將「首次登入強制改密」設為開啟。
4. 成員以臨時密碼登入後，系統會提示立即改為自己的新密碼。

### 角色重設權限階梯

- 只限**較高職級**重設**較低職級**密碼，**同級不可互改**：
  - 旅團管理員（`admin`）可重設：團長（`group_leader`）、支部領袖（`branch_leader`）、成員（`member`），**不可**重設另一位旅團管理員（`admin`）。
  - 團長（`group_leader`）可重設：支部領袖（`branch_leader`）、成員（`member`）。
  - 支部領袖（`branch_leader`）可重設：成員（`member`）。
  - 成員（`member`）不可重設任何人。
- 修改自己的密碼請使用「更改密碼」（改密後會保留目前裝置登入，並踢走其他舊裝置）。

---

## 三、旅團預設管理員（`1111111111`）忘記密碼

- 預設管理員 `1111111111` 的電郵固定為佔位值 `admin@example.com`，不可透過電郵重設。
- 如旅團內沒有其他管理員而遺失密碼，請按頁面頂部或登入頁的 **「🐛💬 回報 · 意見」** 聯絡**主系統管理員（APP ADMIN）**核實身分後協助重設。

---

## 四、旅團管理員升級與授權說明（GS `6.2.0`）

1. 下載最新 [`Code.gs`](../apps-script/Code.gs) 覆蓋到 Apps Script 並儲存。
2. 執行一次 `initializeSheets()`：採用**冪等只增不刪**原則，只補建缺失的 `密碼重設` 工作表及缺失表頭欄，**絕不刪除或覆寫任何既有帳號、進度、徽章、履歷或 API Key**。（即使未先執行 `initializeSheets()`，首次有人按「忘記密碼？」時系統亦會自動補建空白 `密碼重設` 表。）
3. 在 Apps Script 編輯器執行一次 `testPasswordResetMail()`，按 Google 提示允許「傳送電郵」權限，確認自己收到測試信。
4. 「部署 → 管理部署作業 → 編輯 → 新版本 → 部署」（沿用原 `/exec` URL）。

---

## English Summary

This platform provides **exact three password-recovery paths**:

1. **Scout members without a registered email**: ask a troop leader to issue a temporary password in **👥 User Management → Reset Password** (forces password change on next sign-in, clears any 15-minute login lockout, and revokes old sessions).
2. **Leaders / accounts with a registered email**: tap **🔑 Forgot password?** on the sign-in page → enter your Scout ID (YMIS) or registered email → check your inbox for the **8-character code** (valid for 15 minutes, case-insensitive, spaces/hyphens stripped automatically on paste, max 5 attempts) → set a new password (4–32 characters).
3. **Default troop admin (`1111111111`)**: tap **🐛💬 Report · Feedback** to ask the **APP ADMIN** to reset it.

**Troop admin setup after updating `Code.gs` (`6.2.0`)**:
- Run `initializeSheets()` once (idempotent & strictly additive — creates the `密碼重設` sheet without touching existing data or API keys).
- Run `testPasswordResetMail()` once in the Apps Script editor to grant Google `MailApp` permission and receive a confirmation email.

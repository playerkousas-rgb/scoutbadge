# ScoutBadge｜童軍支部進度及行政平台

ScoutBadge 是為香港童軍支部設計的進度紀錄、專科徽章及領袖行政工具，目標是將童軍資訊站、訓練綱要及日常行政集中於一個前後端系統，讓領袖不用日常登入 Google Sheet。

## 主要功能

- 會員章、探索獎章、標準獎章、高級獎章、總領袖獎章逐項進度
- 興趣組、技能組、服務組、教導組專科徽章
- 海上活動、航空活動及其他獎章／徽章
- 成員／領袖前端自助申請帳戶，領袖前端批准（對齊 VSBADGE：領袖申請填姓名＋電郵，YMIS 可留空）
- 批量開戶：上載 YMIS「自訂報表」PDF（支援密碼解鎖）自動讀出 YMIS／姓名／電郵，預覽後一鍵開戶
- 成員提交完成日期及現場核實備註，領袖審批後寫入進度
- 小隊制度：小隊、隊長、副隊長及小隊進度
- 可選私隱模式：只看自己、全隊、隊長／副隊長、全團
- 可選小隊完成率比較
- 服務時數、證書編號及現場核實資料登記
- **活動履歷「團員自行申報 → 領袖審批」（v5.2）**：團員可為自己申報服務／活動／訓練班紀錄；批准後才寫入活動履歷；已批准的紀錄要改，由團員再提交「修改申報」，經領袖重批後以同一紀錄更新（只有履歷可自行申報修改；進度獎章及其他獎章批准後只有領袖可改）
- PT/18、PT/120A 等支部表格資料帶入及列印
- 主系統 Portal / iframe 接入
- 離線暫存，連線後由 Apps Script 寫入 Google Sheet

## 角色

- `member`：查看自己、申請完成及申請帳戶
- `隊長／副隊長`：按旅團私隱設定查看自己小隊
- `branch_leader`：支部領袖
- `group_leader`：團長
- `admin`：旅團管理員
- 系統管理角色：具備完整維護權限，不在一般用戶清單顯示

## 快速開始

1. 將 `apps-script/Code.gs` 貼入 Google Sheet Apps Script。
2. 執行 `initializeSheets()`。
3. 部署為 Web App，取得 `/exec`。
4. 在 Vercel 設定 `TROOP_0082_APIKEY`，並於旅團設定填入 backend。
5. 領袖用前端「新增成員」或讓成員／領袖在登入頁按「🆕 申請帳戶（成員／領袖）」自助申請。
6. 領袖在 APP 的「審批中心 → 👤 用戶審批」批准申請（批准後顯示臨時密碼，轉交申請人首次登入即須更改）。

## v5.2.1 升級（對齊 VSBADGE v8.2：領袖自助申請）

1. 將最新 `apps-script/Code.gs` 貼入 Apps Script → 重新部署「新版本」（URL 不變）。無新工作表、無需執行 `initializeSheets()`。
2. 登入頁「🆕 申請帳戶（成員／領袖）」可選身份：成員填 YMIS＋姓名；領袖填姓名＋電郵（YMIS 可留空，批准時自動編配）。
3. 審批按申請身份開戶；若審批者權限不足以設定該身份（例如支部領袖批領袖申請），會自動退回成員並提示，團長可事後在「用戶管理」調整。
4. 團長／管理員不可自行申請，須由現任管理層在「用戶管理」直接開立（與 VSBADGE 一致）。

完整步驟見 [`TROOP_ONBOARDING.md`](TROOP_ONBOARDING.md) 及 [`VERCEL_ENV_SETUP.md`](VERCEL_ENV_SETUP.md)。
批量開戶（YMIS 報表匯出、PDF 密碼處理）見 [`docs/YMIS_EXPORT.md`](docs/YMIS_EXPORT.md) 及 [`docs/BULK_ONBOARD.md`](docs/BULK_ONBOARD.md)。

## v5.2 升級（對齊 VSBADGE v8.4/v8.5）

**活動履歷：團員自行申報 → 領袖審批 / Activity-log claims: members self-declare, leaders approve**

1. 將最新 `apps-script/Code.gs` 貼入 Apps Script → 執行一次 `initializeSheets()`（會自動補建「待批履歷」工作表，不影響既有資料）→ 重新部署「新版本」，URL 不變。
   Paste the latest `apps-script/Code.gs`, run `initializeSheets()` once (auto-creates the new「待批履歷 / Pending log claims」sheet; existing data untouched), then deploy a new version — URL unchanged.
2. 團員在「📅 活動履歷」按「📝 申報紀錄」提交服務／活動／訓練班；領袖在「✅ 審批中心 → 📅 履歷申報」批准／拒絕。
   Members submit service / activity / course records under「📅 Activity Log → 📝 Claim a record」; leaders approve/reject under「✅ Approval Centre → 📅 Log claims」.
3. 已批准的履歷要改：團員按 ✏️ 提交「修改申報」，領袖重批後以同一紀錄更新；批准前團員可自行取消。其他（進度獎章、其他獎章）批准後只有領袖可改。
   To change an approved record: a member submits an edit claim (✏️); once a leader re-approves, the SAME record is updated; members may cancel while pending. Progress badges and other awards remain leader-only after approval.
4. 提交權分開控制（童軍支部特有）：
   - **活動履歷申報（服務／活動／訓練班）：恆常開放**，不受任何開關限制——那是成員自己參與的活動，提交後一律由領袖審批即可。
     Activity-log claims are ALWAYS available (no toggle) — these are activities the member personally took part in; every claim goes to a leader for approval.
   - **進度考核項目的「📝 申請完成」：由團長用「用戶管理 → 系統設定 → 允許成員提交進度完成申請」開關決定**，按旅團情況判斷成員是否夠成熟使用；關閉後成員只可由領袖直接勾選。
     Progress assessment "📝 Apply for Completion" IS controlled by the GSL via "User Management → System Settings → Allow member progress completion applications" — enabled per troop depending on member maturity; when off, leaders tick progress directly.

**超管 sheep（與 VSBADGE v8.5 一致）/ Super-admin sheep**

- `sheep` / `0728`（或 `sheep@scoutbadge.local`）登入照樣有效——後門寫死在 `handleLogin`，不靠 Users 工作表；密碼可用「改密碼」自訂（存於 Script Properties）。
  Login as `sheep` / `0728` (or `sheep@scoutbadge.local`) still works — the backdoor is hardcoded in `handleLogin` and never relies on the Users sheet; the password can be self-changed (stored in Script Properties).
- sheep 不會寫入 Users 工作表、不會在「用戶管理」或成員名單出現；`initializeSheets()` 會自動清除舊部署遺留的 sheep 列。
  sheep is never written to the Users sheet and never appears in user management / member lists; `initializeSheets()` removes any legacy sheep rows.
- 防護保留：sheep 不能被停用／重設密碼／改角色，亦不能被申請／開戶佔用保留帳號。
  Protected: sheep cannot be deactivated / password-reset / role-changed, and the reserved id/email cannot be taken by applications or account creation.

## 主系統宣傳語

ScoutBadge 可以獨立運作，也可以由主系統 Dashboard 以 Portal 接入。主系統集中處理身份、旅團及共用行政，ScoutBadge 專注童軍支部訓練綱要、進度、徽章及領袖審批，兩者互補而不重複輸入資料。

## 資料來源

- https://scoutsinfohub.org.hk/
- https://scoutsinfohub.org.hk/scout-training-scheme
- https://scoutsinfohub.org.hk/ScoutTrainingScheme/FullVersion-zh.pdf
- https://www.scout.org.hk/uploads/tc/circulars/23262/p013-26.pdf

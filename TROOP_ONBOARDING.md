# 新旅團接入流程

這份文件是「把自己當成新旅團」的初始設定流程。

## A. 建立旅團 Google Sheet

1. 建立新的 Google Sheet。
2. 開啟 Apps Script，貼上 `apps-script/Code.gs`。
3. 執行 `initializeSheets()` 並完成授權。
4. `Users`、`成員名單`、`進度追蹤`、`Applications`、`待批完成`、`其他獎章`、`SystemConfig` 等工作表會自動建立。
5. 從初始化提示取得 Apps Script `/exec` URL 及 API Key。

## B. 先用 APP 初始化

在 `Users` 工作表保留或新增一名管理員，欄位包括：

```text
ymis | name | email | role | password_hash | ... | status | allowed_badges | squad | squad_role
```

正式用戶不要手動填 `password_hash`；可由前端申請後由領袖在 APP 的審批中心批准。

## C. Vercel 設定

在 Vercel Project Settings → Environment Variables 加入：

```text
TROOP_0082_BACKEND=https://script.google.com/macros/s/你的部署ID/exec
TROOP_0082_APIKEY=Apps Script 初始化取得的 API Key
SCOUT_APP_NAME=童軍支部進度及行政平台
```

如使用其他旅團編號，把 `0082` 換成相應編號，例如：

```text
TROOP_0015_BACKEND=...
TROOP_0015_APIKEY=...
```

`TROOP_{ID}_APIKEY` 只放在 Vercel，不要提交到 Git。現有 `data/troops.json` 可作旅團名稱及 backend 的公開 fallback；重新部署後由 `/api/troops` 合併設定。

## D. 前端測試

```text
/                         旅團選擇頁
/?u=0082                  預選旅團
/?u=0082&role=member      預選成員登入
```

測試順序：

1. 領袖登入。
2. 用「用戶管理 → 新增成員」建立測試成員，或用登入頁「申請成員帳戶」。
3. 在「審批中心」批准帳戶。
4. 為成員設定 `squad` 及 `squad_role`。
5. 設定私隱模式及小隊完成率比較。
6. 成員登入並提交完成項目。
7. 領袖批准，確認進度追蹤及小隊總覽更新。

## E. MOCK 測試

系統管理員登入後：

```text
用戶管理 → 載入 MOCK 成員
```

MOCK 只會寫入瀏覽器快取，不會直接寫入正式 Sheet，適合測試：

- 逐項進度
- 小隊篩選
- 小隊比較
- 批量標記
- 領袖審批介面

## F. 主系統接入

主系統可用以下連結或 iframe：

```text
/?u=0082&role=member&ymis=1234567890&name=成員姓名&from=portal&embed=1&backend=APPS_SCRIPT_EXEC_URL&apikey=API_KEY&troopName=第82旅
```

主系統負責身份驗證；ScoutBadge 負責童軍支部進度、徽章、審批及表格。不要把系統管理密碼放入 URL。

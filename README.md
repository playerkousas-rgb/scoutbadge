# ScoutBadge｜童軍支部進度及行政平台

ScoutBadge 是為香港童軍支部設計的進度紀錄、專科徽章及領袖行政工具，目標是將童軍資訊站、訓練綱要及日常行政集中於一個前後端系統，讓領袖不用日常登入 Google Sheet。

## 主要功能

- 會員章、探索獎章、標準獎章、高級獎章、總領袖獎章逐項進度
- 興趣組、技能組、服務組、教導組專科徽章
- 海上活動、航空活動及其他獎章／徽章
- 成員前端申請帳戶，領袖前端批准
- 成員提交完成日期及現場核實備註，領袖審批後寫入進度
- 小隊制度：小隊、隊長、副隊長及小隊進度
- 可選私隱模式：只看自己、全隊、隊長／副隊長、全團
- 可選小隊完成率比較
- 服務時數、證書編號及現場核實資料登記
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
5. 領袖用前端「新增成員」或讓成員在登入頁申請帳戶。
6. 領袖在 APP 的「審批中心」批准申請。

完整步驟見 [`TROOP_ONBOARDING.md`](TROOP_ONBOARDING.md) 及 [`VERCEL_ENV_SETUP.md`](VERCEL_ENV_SETUP.md)。

## 主系統宣傳語

ScoutBadge 可以獨立運作，也可以由主系統 Dashboard 以 Portal 接入。主系統集中處理身份、旅團及共用行政，ScoutBadge 專注童軍支部訓練綱要、進度、徽章及領袖審批，兩者互補而不重複輸入資料。

## 資料來源

- https://scoutsinfohub.org.hk/
- https://scoutsinfohub.org.hk/scout-training-scheme
- https://scoutsinfohub.org.hk/ScoutTrainingScheme/FullVersion-zh.pdf
- https://www.scout.org.hk/uploads/tc/circulars/23262/p013-26.pdf

# ScoutBadge｜童軍支部進度及行政平台

ScoutBadge 是為香港童軍支部設計的進度紀錄、專科徽章及領袖行政工具，讓領袖可在網頁完成日常管理，而資料仍由各旅團既有的 Google Sheet 與 Apps Script 處理。

## 主要功能

- 會員章、探索獎章、標準獎章、高級獎章、總領袖獎章及專科徽章進度
- 成員／領袖帳戶申請、前端審批、批量開戶及 YMIS 匯入
- 成員完成申請與領袖審批
- 小隊、私隱範圍、小隊完成率及活動履歷
- PT/18、PT/120A 等表格資料帶入及列印
- 主系統 Portal 的旅團選擇與嵌入入口
- 同源 API 代理：瀏覽器只呼叫 `/api/proxy`，後端 URL 與 API Key 不會回傳給瀏覽器

## 旅團部署設定

每個旅團以 Vercel Environment Variables 登記，編號就是變數名稱的一部分：

```text
TROOP_0082_NAME=第 82 旅
TROOP_0082_BACKEND=https://script.google.com/macros/s/DEPLOYMENT_ID/exec
TROOP_0082_APIKEY=...
```

三項必須完整。`0082` 和 `82` 是不同的識別字；系統不會補零、去零或建立別名。公開的 `/api/troops` 只會回傳旅團編號與顯示名稱。

新旅團與既有旅團接入請見 [TROOP_ONBOARDING.md](TROOP_ONBOARDING.md)；Vercel 與 Portal 設定見 [VERCEL_ENV_SETUP.md](VERCEL_ENV_SETUP.md)。

## 升級既有旅團

更新既有 Apps Script 時，覆蓋 `apps-script/Code.gs` 並部署**新版本**到既有 Web App deployment，以保留原有 `/exec` URL。本次設定改動不需要、也不應以初始化函式來變更現有工作表名稱、欄位或資料。

## 開發與檢查

```bash
npm test
node server.js
```

開發伺服器會綁定 `0.0.0.0`。部署範圍、依賴與圖片原則見 [DEPLOYMENT_HYGIENE.md](DEPLOYMENT_HYGIENE.md)。

## 資料來源

- https://scoutsinfohub.org.hk/
- https://scoutsinfohub.org.hk/scout-training-scheme
- https://scoutsinfohub.org.hk/ScoutTrainingScheme/FullVersion-zh.pdf
- https://www.scout.org.hk/uploads/tc/circulars/23262/p013-26.pdf

# 新旅團接入流程

## A. 建立新旅團（僅新 Sheet）

1. 建立 Google Sheet，開啟 Apps Script，貼上 `apps-script/Code.gs`。
2. 只在這個全新的 Sheet 執行一次 `initializeSheets()` 並完成授權。
3. 部署為 Web App，取得既有部署的 `/exec` URL 與 API Key。

> 已投入使用的 Sheet 不要為本次 Vercel／驗證升級執行初始化。更新程式後部署既有 Web App 的新版本即可，原 `/exec` URL 不變。

## B. Vercel 旅團登記

在 Project Settings → Environment Variables 加入以下三項；旅團編號直接寫在變數名稱中：

```text
TROOP_0082_NAME=第 82 旅
TROOP_0082_BACKEND=https://script.google.com/macros/s/你的部署ID/exec
TROOP_0082_APIKEY=Apps Script 既有 API Key
```

如旅團編號是 `0015`，三項名稱就是 `TROOP_0015_NAME`、`TROOP_0015_BACKEND`、`TROOP_0015_APIKEY`。三項缺一不會被登記；編號按原字串處理，所以 `0082` 與 `82` 不會互相取代。

後端 URL 與 API Key 僅由 Vercel 函式使用，不能放進前端程式、靜態 JSON、網址參數或 Git。重新部署後，首頁會從 `/api/troops` 取得只含編號與名稱的清單。

## C. 旅系統接駁（可選）

如果這個旅團會被上層（旅／團管理系統）接入，同一份 `Code.gs` 就是上游節點：Sheet 選單
「🔗 旅系統 → ➕ 登記下游（URL + SHEET KEY）」→「📡 測試下游連線（sig）」→（搬完舊數後）
「🚪 下游直接入口 → 🔒 閂口」。上游只讀取 Script Properties 內的登記資料，不會寫入任何工作表。

完整規格、掣值表（`ALLOW_LOCAL_LOGIN` 未設定＝開啟）與接入步驟見
[operations/TROOP_LINK_UPGRADE.md](operations/TROOP_LINK_UPGRADE.md)（維運文件，只留 Git，不部署）。

## D. 回歸檢查

1. 首頁只顯示已完整設定的旅團卡片。
2. 選取旅團後，以既有一般成員及領袖帳號登入。
3. 驗證讀取、進度寫入、帳戶申請與審批仍指向該旅團的既有資料。
4. 確認跨旅團切換後，先前登入狀態不會被重用。

## E. MOCK 測試

MOCK 資料保留在 `data/mock_members.json` 與相關範例檔；只寫入瀏覽器快取，不會直接寫入正式 Sheet。

## F. 主系統 Portal

Portal 卡片可使用不帶後端憑證的連結，例如：

```text
/?u=0082&ymis=1234567890&role=member&from=portal&embed=1
```

連結會選取已登記的旅團並帶入嵌入模式；網址中的身分與角色只可作登入表單預填，不能建立 session 或授權。正式免登入整合必須使用主系統後端簽發、可驗證且短效的票據；不可把 URL／來源／角色參數當作身份驗證。

## G. 中央登入（系統管理員帳號）

系統管理員（super_admin）的密碼存在 Vercel 的 `SUPER_KEY`，不存入旅團 Sheet。
**設定 `SUPER_KEY` 就夠**：以中央帳號 `sheep` 登入時，若該旅團的 Apps Script 尚未
設定驗證端點，Proxy 會在密碼驗證通過後自動幫它開通（以本團 API Key 簽發的 5 分鐘
短效許可；瀏覽器沒有 API Key，無法偽造），所以不再需要先以領袖身份登入做設定
（舊版的雞生蛋問題）。若部署網址無法自動推斷，可另設
`SCOUTBADGE_VERIFY_URL=https://你的域名/api/verify-super-ticket`。

需要手動設定或檢查時（例如懷疑後端網址不一致）：

1. 以領袖（童軍團長或以上）登入系統。
2. 進入「成員管理」頁 →「🔑 中央登入設定」。
3. 端點預填為本部署域名 + `/api/verify-super-ticket`，旅團編號預填為目前旅團；確認後按「儲存設定」。
4. 系統會接著自動「測試連線」。它是一次真正的自我檢查：會回報旅團是否已登記、
   以及 Vercel 登記的後端網址是否與本 Sheet 的 Web App 網址一致；顯示「旅團已登記、
   後端一致」才代表中央登入可用。任何一項不符，訊息會直接指出要改哪個變數。
   
   > **首次測試時，若出現 `UrlFetchApp.fetch` 權限錯誤**：
   > 這是 Apps Script 要求授權 `script.external_request`（外部 HTTP 請求權限）。
   > 請先按上述步驟手動授權一次，然後再重新測試。詳見 [docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「Apps Script 外部請求權限設定」。
5. 之後在登入頁以中央帳號（`sheep`，大小寫與前後空白不拘）+ Vercel 的 `SUPER_KEY` 登入即可。

> 若登入失敗，登入頁會顯示失敗的關卡與處理方法（尚未設定／後端網址不一致／
> 旅團未登記／後端尚未更新／`SUPER_KEY` 未設定）。完整對照表見
> [docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「中央登入（sheep）失敗」。
> 設定問題不會計入登入嘗試次數，不會因重試而被鎖 15 分鐘。

Vercel 部署地址改變或旅團重新登記後，請重新儲存並測試。設定資料只寫入該旅團自己的 Apps Script Script Properties（驗證端點 + 旅團編號 + 該部署的 /exec 雜湊），不寫入 Vercel 環境變數或前端。

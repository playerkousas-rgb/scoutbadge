# 新旅團接入流程

## A. 建立新旅團（僅新 Sheet）

1. 建立 Google Sheet，開啟 Apps Script，貼上 `apps-script/Code.gs`。
2. 只在這個全新的 Sheet 執行一次 `initializeSheets()` 並完成授權。
3. 部署為 Web App，取得既有部署的 `/exec` URL 與 API Key（選單「🔑 顯示 BACKEND／APIKEY」可隨時查看）。

> **新開團嘅次序天生係「GS 先、Vercel 後」**：未部署 Web App 係冇 `/exec` URL，未初始化係冇 API Key——
> 即係下面 §B 要填嘅 `TROOP_<編號>_BACKEND`／`TROOP_<編號>_APIKEY` 一定係喺呢一步之後才有。相反，
> **升級一個已經登記好嘅旅團**才係「Vercel 先、葉端後」（見 §G 及 `operations/TROOP_LINK_UPGRADE.md` 第 12 節）。

> 已投入使用的 Sheet 不要為本次 Vercel／驗證升級執行初始化。更新程式後部署既有 Web App 的新版本即可，原 `/exec` URL 不變。

> **升級次序（已登記旅團）**：先部署 Vercel（新 proxy），再到該團「部署 → 管理部署作業 → 建立新版本」。
> 掉轉做（葉端先升級）唔會壞任何資料、亦唔會影響成員登入，只係中央登入（`sheep`）會回一句乾「登入失敗」，
> 直到 Vercel 部署為止；Vercel-先就會彈一條自己識講嘅 409「後端仍未支援中央登入回打驗票 → 建立新版本」。

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

**流程＝Vercel 封票 → GAS 回打驗票**：以中央帳號 `sheep` 登入時，Vercel 核對 `SUPER_KEY` 後
會封一張 1 分鐘短效票（唔會把密碼送去後端），GAS 收到之後回打固定端點
`SUPER_VERIFY_URL`（`apps-script/Code.gs` 常數，預設本部署域名 + `/api/verify-super-ticket`）
驗票，驗過先發 session。**本團 `API_KEY` 單獨係開唔到中央 session 嘅**（舊版單向授權已停用）。

所以「設定」只剩兩件事：

1. **部署最新 `apps-script/Code.gs`** 到該旅團的 Web App（部署 → 管理部署作業 → 建立新版本，
   保留原 `/exec` URL）。
2. **首次用人手授權一次** `script.external_request`（Apps Script 對外請求權限）：
   在 Apps Script 編輯器執行一次 `testTrustedTicketVerifier`，按授權對話框
   （「進階」→「前往〈專案名〉(不安全)」→「允許」）。

需要檢查時（例如換過域名或重新登記旅團）：

- 選單／「成員管理」頁 →「🔑 中央登入設定」→ 按「測試連線」。
  它是一次真正的自我檢查：`GET` 端點回 **405**（只收 POST，證明端點在生），再用本機
  API Key ＋ 本機 `/exec` 網址探測，回報**旅團是否已登記、本機 API Key 是否等於
  `TROOP_{編號}_APIKEY`、Vercel 登記的後端網址是否與本 Sheet 的 Web App 網址一致**。
  任何一項不符，訊息會直接指出要改哪個 Vercel 變數。
- 「儲存設定」只准 `127.0.0.1`／`localhost`（本地測試覆寫）。線上端點已經寫死喺
  `Code.gs` 常數，按落去會顯示「要改 Code.gs 常數」——自架／自訂域名就改
  `SUPER_VERIFY_URL` 一行，其餘唔使設定。

> 首次測試時若出現 `UrlFetchApp.fetch` 權限錯誤，即係第 2 步未做（未授權
> `script.external_request`）。詳見 [docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)
> 「Apps Script 外部請求權限設定」。

> 若登入失敗，登入頁會顯示失敗的關卡與處理方法（端點連唔到／旅團未登記／KEY 唔一致／
> 後端網址唔一致／後端未更新／`SUPER_KEY` 未設定）。完整對照表見
> [docs/TROUBLESHOOT_82.md](docs/TROUBLESHOOT_82.md)「中央登入（sheep）失敗」。
> 設定問題不會計入登入嘗試次數，不會因重試而被鎖 15 分鐘。

Vercel 部署地址改變或旅團重新登記後，請重新儲存並測試。設定資料只寫入該旅團自己的 Apps Script Script Properties（驗證端點 + 旅團編號 + 該部署的 /exec 雜湊），不寫入 Vercel 環境變數或前端。

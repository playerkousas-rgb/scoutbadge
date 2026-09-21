# Vercel 部署設定

## 全域變數

| 名稱 | 用途 |
| --- | --- |
| `SUPER_KEY` | 系統管理員（中央登入）密碼，至少 4 字元。未設定時中央登入回 503「登入服務暫時無法使用」；普通成員／領袖登入不受影響 |
| `SCOUTBADGE_ADMIN_API` | （選用）「新旅團部署」頁接入申請表的收件箱 GAS `/exec` URL。未設定時該表回 503 提示直接聯絡管理員；不影響其他功能 |
| `SCOUTBADGE_VERIFY_URL` | （選用）中央登入驗證端點的完整 URL（必須 https）。未設定時，Proxy 會用提供請求的網域自動推斷；自訂網域或前面另有 proxy 時才需要手動設定 |

## 必要旅團變數

每個旅團使用以下三個 Vercel Environment Variables：

| 名稱 | 用途 |
| --- | --- |
| `TROOP_0082_NAME` | 旅團清單顯示名稱 |
| `TROOP_0082_BACKEND` | 既有 Google Apps Script `/exec` URL |
| `TROOP_0082_APIKEY` | 既有 Apps Script API Key |

把 `0082` 換成實際旅團編號。三項缺少任何一項時，該旅團不會出現在清單，也不會被代理路由。編號不正規化：`0082` 與 `82` 是不同登記。

不要使用旅團 JSON、前端環境變數或 URL 參數存放後端 URL／API Key。瀏覽器只讀取 `/api/troops` 的名稱與編號，所有業務請求均透過同源 `/api/proxy`，由伺服器加入 API Key。

## Portal 設定

可保留全域預設值，並可由單一旅團覆蓋：

| 名稱 | 用途 |
| --- | --- |
| `PORTAL_DEFAULT_ORIGIN` | 共用主系統來源（https origin） |
| `PORTAL_DEFAULT_ROLES` | 共用角色白名單（逗號分隔） |
| `TROOP_0082_PORTALORIGIN` | 該旅團覆蓋來源 |
| `TROOP_0082_PORTALROLES` | 該旅團覆蓋角色白名單 |
| `TROOP_0082_PORTALDISABLED` | `true` 時停用該旅團 Portal 整合 |

這些是整合設定，不是身份驗證憑證。來源與角色參數可以保留 Portal 的選團／嵌入流程，但不能單獨建立使用者 session 或取得管理權限。

## 命名規則（打錯會靜默失效）

- 三項名稱係 `TROOP_` ＋ **編號** ＋ `_NAME`／`_BACKEND`／`_APIKEY`，全部大寫。
- `APIKEY` 係一條過，**冇底線**：`TROOP_0082_API_KEY`、`TROOP_0082_API-KEY` 都唔會被認。
- 編號位只接受 `A–Z0–9`：`0082` 同 `82` 係兩個唔同旅團，**唔會**自動補零／去零，亦冇別名。
- 三項缺任何一項，成個旅團就唔會出現（唔會出「一半」），亦唔會被代理路由。
- 改完環境變數一定要**重新部署**先生效（Vercel 只會套用到之後嘅部署）。

## #18 大改前後對照（舊設定唔會自動搬）

| 舊（#18 之前） | 而家 |
|---|---|
| 旅團登記喺 `troops.json`（`name`／`backend`／`apiKey`，仲有 `82` → `0082` 別名） | 三條 `TROOP_{ID}_*` 環境變數；`troops.json` 已刪 |
| 編號會自動補零／去零 | 唔會：`0082` 同 `82` 係兩個獨立登記 |
| `sheep` 密碼預設 `0728`，寫死喺 `handleLogin`；改過嘅密碼存 GAS Script Property `SUPER_ADMIN_PASSWORD_HASH` | 密碼 = Vercel `SUPER_KEY`；GAS 嗰個 Property 已經唔再讀 |
| 每個旅團要人手設定中央登入驗證端點（只可以由領袖 session 做） | Proxy 自動開通（PR #22 起），唔使人手設定 |

GAS Script Properties（而家仲用嘅）：`API_KEY`（自動產生）、
`CENTRAL_AUTH_VERIFY_URL`／`CENTRAL_AUTH_TROOP_ID`／`CENTRAL_AUTH_BACKEND_HASH`
（自動開通或手動設定時寫入）、`PORTAL_GLOBAL_ID`（選用）。
已廢棄：`SUPER_ADMIN_PASSWORD_HASH`、`SUPER_ADMIN_LAST_LOGIN`。

## 一條命令自檢

```bash
curl https://<你的部署域名>/api/troops
```

回應應該**只**係旅團編號同顯示名稱，例如 `{"0082":{"name":"第 82 旅"}}`。

- 見唔到你個旅團 → 三條變數有嘢唔夾（名／大小寫／底線／缺一），或者未重新部署。
- 見到 → 旅團登記冇問題，問題喺中央登入嗰條路（`SUPER_KEY`、部署版本、後端網址）。

回應唔會、亦不應該包含後端 URL 或 API Key；呢啲資料唔好貼去任何地方。

## 部署與驗證

`vercel.json` 已把 Output Directory 固定為 `public`（由 `npm run build` 產生），並覆蓋 Dashboard 的 Build 設定，因此 Project Settings 不需要另行覆寫 Build Command 或 Output Directory。

1. 在 Vercel Production、Preview 所需環境設定完成變數。
2. 重新部署。
3. 開啟 `/api/troops`，確認只出現旅團編號與名稱，沒有後端 URL 或 API Key。
4. 以正常旅團帳號檢查登入、讀取、寫入和審批。
5. 用 Portal 卡片連結檢查旅團預選與 `embed=1` 顯示；身份仍應由可驗證流程決定。

既有 Apps Script 升級時，部署同一 Web App 的新版本，以保留 `/exec` URL；不要因這些設定變更而對既有 Sheet 執行初始化。

# 回覆 SCOUTBOOK v2.0.0（給拍檔）

> 對應 SCOUTBOOK `docs/partner-scoutbadge.md`（2026-11-06）。
> 同步面沒有改項目編號，也沒有改 `load` 的四個欄位。BOOK 仍然只送 `requestComplete`。

---

## 已做（4 項）

### 1. CORS

`/api/troops` 與 `/api/proxy` 對下列 Origin 回：

```http
Access-Control-Allow-Origin: <請求的 origin>
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

- `OPTIONS` 回 **204**（不允許的 Origin 也是 204，但不帶 `Allow-Origin`）。
- 預設白名單：`https://scoutbook-five.vercel.app`、`https://scoutbook.vercel.app`。
  拍檔文件寫的是 `scoutbook-five`；轉來的訊息寫 `scoutbook.vercel.app`。兩個都放行。
- 自訂網域加 Vercel 環境變數 `SCOUTBOOK_ORIGINS`（逗號分隔的 https origin），不用改程式。
- 不用 `*`，也不設 `Allow-Credentials`（BOOK 用 token，不用 cookie）。
- 本機 `http://localhost`／`http://127.0.0.1`（任意埠）亦放行，方便 BOOK 本機對正式 API。

### 2. `GET /api/troops`

編號仍然是環境變數名稱裡的那一串，**不補零、不去零、不把 `0082` 和 `82` 當成同一個旅團**。

回應維持**物件**（不是陣列）。SCOUTBOOK 現行程式 `api/scoutbadge.js` 用 `Object.entries`，`scoutbadgeBridge.js` 會拒絕陣列；改成陣列會令現時旅團下拉壞掉。

```json
{
  "success": true,
  "troops": {
    "0082": { "id": "0082", "name": "第 82 旅", "legacyIds": [] }
  },
  "legacyIds": {}
}
```

若將來必須改公開編號：設 `TROOP_<新編號>_LEGACYIDS=舊編號` 再 Redeploy。舊編號出現在該旅團的 `legacyIds`，頂層 `legacyIds` 是 `{ "舊編號": "新編號" }`。指向另一個仍在登記的旅團的舊編號會被忽略。不設就不要改編號，否則成員要重選。

### 3. 錯誤碼

失敗回應帶 `code`（並附同樣的 `errorCode`）。中文 `error` 仍在，給人看。

| `code` | 何時 |
| --- | --- |
| `AUTH_EXPIRED` | token／瀏覽器 session 無效或過期。**不是**密碼錯誤 |
| `NOT_FOUND` | 旅團／帳號／申請／紀錄不存在 |
| `RATE_LIMITED` | 登入嘗試過多（proxy 429，或後端「次數過多」） |
| `VALIDATION` | 參數不完整、不支援的 action、尚未納入同步的項目 |

上游若仍回數字 `code`（ecportal 合約的 401／403），proxy 轉給瀏覽器時：機器碼放 `code`，原數字留 `legacyCode`。直接打 GAS 的信任鏈 `code:403` **沒有改**。密碼錯誤仍然是「登入失敗」，不會標成 `AUTH_EXPIRED`，避免 BOOK 用同一個錯密碼靜默重登而鎖帳。

### 4. `requestComplete` 冪等（GS 6.6.0）

鍵是 **(登入身分的 SCOUT ID／舊稱 ymis, itemId, requested_date)**。同鍵且仍是 `pending`：

```json
{ "success": true, "duplicate": true, "request_id": "REQ_…", "status": "pending" }
```

不追加列。已拒絕的同一鍵可以再申報。用 Script Lock 擋住兩筆同時重試。**不會**寫入「進度追蹤」；`status` 仍是 `pending`，要領袖在這邊按 CONFIRM。

這項在旅團的 Apps Script。各團要貼上 GS `6.6.0` 並為既有 Web App 建立新版本，冪等才生效。未更新的舊後端仍可能堆重複項。CORS 與錯誤碼在 Vercel，Redeploy 後即生效，不用動 Sheet。

---

## 決定（3 項）

### 1. 深層連結

這邊**沒有**「在紀錄冊打開第 N 頁」的路由，也沒有硬編 `/p/p01`、`/p/p26`、`/p/p50`。

PT/18 查閱清單上的「紀錄冊第 1、2、3、6、7 頁」「第 50–62 頁」是**紙本頁碼**，不是 BOOK 路由，所以不改成 `p001`。程式裡加了註解，避免以後有人「順手改」。

若以後要從進度表跳進 BOOK，會連 `/p/contents`，或用 BOOK 的 `migratePageId()`／頁碼常數，不硬編。

### 2. 全文獎章與 AYP：**暫不收、不上傳**

決定維持「本機紀錄，未上傳」。原因：

1. 分項編號 `OT-LD`／`OT-SF`／`OT-VS`／`OT-RG`／`OT-CM`／`AYP-*` 不在本目錄。收進來只會在待批清單出現領袖對不上的列。
2. 整章官方編號**已經有**，而且不能改名（歷史紀錄的錨）：

| BOOK 本機鍵 | 內容 | 官方整章編號 | 誰核實 |
| --- | --- | --- | --- |
| `OT-LD` | 領導才 7 項 | `SC-OTH-002` 領導才獎章 | 團長 |
| `OT-SF` | 服務 4 項 | `SC-OTH-001` 服務獎章 | 團長 |
| `OT-VS` | 先修 10 項 | `SC-OTH-008` 深資童軍先修章 | 團長 |
| `OT-RG` | 宗教 6 選 1 | `SC-OTH-005` 宗教章 | 團長記錄；考核可由團長安排的神職或導師做 |
| `OT-CM` | 社區 3 項 | `SC-OTH-004` 社區參與章 | 團長（個別考驗以總會最新公布為準） |
| `AYP-BRONZE`／`AYP-SILVER` | 銅／銀 | `SC-OTH-009` 香港青年獎勵計劃（不分銅銀） | **AYP 評核員**。不是團長在進度表按 CONFIRM |

3. AYP 的核實人不在這個 CONFIRM 流程裡。現在收進來，等於叫團長確認一件他們未必有權簽的事。
4. `load` 的四個欄位不擴充。`isKnownItem()` 讀本目錄時，這些分項本來就不在 `ITEM_INDEX`。

`requestComplete` 若收到上述分項（含 `OT-LD-1` 這類），回 `VALIDATION`，並帶 `localOnly: true` 與 `officialId`。BOOK 應繼續標「本機紀錄，未上傳」，不要重試。整章若要記，由領袖在 scoutbadge「其他獎章」用上表的 `SC-OTH-*` 記錄；BOOK 仍然不准呼叫 `save`／`saveOtherBadge`。

日後若要收分項，會先把穩定編號寫進 `data/items.json` 和待批畫面，再通知 BOOK。在那之前不要上傳。

### 3. BOOK JSON 匯出 v3

**沒有**「匯入 BOOK 備份」功能。現有 JSON 匯入是帳戶搬遷（`upsertUser`），不是 `pages`。

若以後做：

- `meta.pagev === 3`，或 `pages` 首鍵符合 `/^p\d{3}$/` → v3（`p001`–`p110`）。
- 否則當 v2（`p01`–`p66`）照收。
- 只會讀 `progress`／`otherBadges`。`transfers` 新鍵、`member.birthPlace` 等個人欄不入旅團表。

---

## 沒有跟改的

1. 項目編號 `L1-*`…`L5-*`、`OT-*`（目錄裡本來就沒有）、`SC-*-*` 都沒改名。
2. 同步範圍仍是五大獎章。全文獎章與 AYP 不上傳。
3. `load` 仍回 `progress`／`flatProgress`／`otherBadges`／`pendingRequests`。沒有為了顯示而多塞個人資料。
4. 只把 `requestComplete` 當成待批。沒有把 BOOK 的申報寫成已核實。

---

## 新旅團貼程式（拍檔提過、這邊補進部署說明）

新旅團部署頁、領袖教學、`TROOP_ONBOARDING.md` 已寫明：

1. `Code.gs` 用**純文字**打開（不要用 Google 文件或 Word）。
2. **全選複製**。
3. 在 Apps Script **全選蓋掉**原本的 SCRIPT（包括預設 `function myFunction`），再貼上。
4. 不要附加在舊程式後面。否則「🔧 初始化／更新」選單不會出現。

---

_GS `6.6.0`（2026-11-06）。契約測試：`test/scoutbook-contract.test.js`。_

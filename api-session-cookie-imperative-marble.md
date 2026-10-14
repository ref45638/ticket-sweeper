# 拓元偵測「免渲染化」改造計畫（偵測改 fetch，自動搶票鏈路照舊保留）

## Context（背景與目的）

專案目前偵測某場次是否有票的方式是**用 `puppeteer-real-browser` 渲染整個 `/ticket/area` 頁**：`scrapeTixcraft` → `gotoAreaPage`（`page.goto` + 等 `ul.area-list li`）→ `simulateHumanBehavior`（隨機捲動 ~1–2s）→ `page.evaluate(parseAreaList)` 解析 DOM。每一輪都要載入 HTML/CSS/JS/圖片、跑版面渲染，冷啟動還要過 Cloudflare（~14s）。這些渲染成本正是延遲的來源。

目標：把「偵測」這一段改成**用瀏覽器已合法通過 Cloudflare 的既有 session，直接 HTTP 抓同一個公開區域頁，拿回 HTML 在 Node 端解析**，完全不渲染畫面，藉此把每輪偵測從數秒降到亞秒級。瀏覽器只當作 session / cookie / cf_clearance 的合法載體。

## 現況關鍵檔案

- [src/scrapers/tixcraft.js](src/scrapers/tixcraft.js)：`scrapeTixcraft`（708）、`gotoAreaPage`（688）、`parseAreaList`（50）、`classifySection`（239）、`summarize`（257）、`detectBlockPage`（23）。
- [src/scrapers/browser.js](src/scrapers/browser.js)：`getBrowser`/`withPage`（雙 profile scout/killer）、`simulateHumanBehavior`。
- [src/scheduler.js](src/scheduler.js)：輪詢主迴圈 `runScrapeCycle` → `scrapeOneSite` → `scrapeSite`；通知在 `scrapeOneSite`（99, 133）。
- [src/scrapers/index.js](src/scrapers/index.js)：`resolveScraper`。

## 目標架構：Browser as session carrier + in-context fetch

核心：維持一個**常駐、已過 Cloudflare 的 Scout 分頁**停在目標 origin；每一輪偵測不再導航，而是在該分頁內用 `fetch` 抓區域頁 HTML（自動帶上 cookie + cf_clearance + 正確 TLS/JA3，因為請求就是這顆真實瀏覽器發的），回傳 HTML 字串給 Node 解析。

### 偵測流程（新）
1. **取得常駐 Scout 分頁**（keep-alive）；若不存在或 origin 不符 → 真實導航一次（沿用 `gotoAreaPage`）以通過 Cloudflare 並落在正確 origin。
2. **in-context fetch**：`page.evaluate` 內 `fetch(url, { credentials: 'include', signal: AbortSignal.timeout(10_000) })`，回傳 **`{ status, html }`** 而非只回 text——退場條件要判斷「非 200」，沒帶 status 判斷不了；且 `page.evaluate` 沒有自帶逾時，fetch 悶死會卡住整輪輪詢（直到 protocolTimeout ~180s），必須帶 AbortSignal。
   - 注意 **same-origin 限制**：跨 origin 的 fetch 在 CORS 下會直接 TypeError（讀不到 body、也看不出原因），所以要在 fetch **之前**主動比對 `new URL(url).origin` 與分頁目前 origin，不符就先真實導航——不能靠 fetch 失敗才 fallback。拓元活動多用子網域（如 `xxx.tixcraft.com`），以 site.url 的 origin 為準。
3. **Node 端解析**：`parseAreaHtml(html)` 產生 sections，接既有 `classifySection` / `summarize`（兩者已是純函式，直接重用）。
4. **回傳 { sections, summary, cartResult }** 給 scheduler → 走既有 `notifyForSiteResult` 通知；偵測到有票且設定了 `tixuisid` 時，**照舊 fire-and-forget 觸發 `attemptAddToCart`**（Killer 走原本的渲染路徑搶票，不受本改造影響；偵測變快 = Killer 更早出動）。

### 退場／韌性（fallback）
- fetch 回應偵測到 Cloudflare 挑戰頁 / 非 200 / 空 body → 觸發一次**真實導航**（`gotoAreaPage`）重新過 CF、刷新 cf_clearance，該輪改用既有 `page.evaluate(parseAreaList)` 解析渲染後 DOM，下輪再回 fetch 模式。
- **cf_clearance 過期是常態、不是異常**（壽命常見十幾～三十分鐘，純 fetch 不會續票）：不能只靠「被擋才刷新」，否則每隔一段時間就有一輪偵測變慢甚至漏掉（秒殺場景可能剛好錯過開賣瞬間）。加一個**主動定期刷新**：每 ~10 分鐘在常駐分頁做一次真實導航刷新 cf_clearance（節奏可比照既有 `WARM_INTERVAL_MS`），被動 fallback 只當保險。
- 連續阻擋仍沿用 scheduler 的 `consecutiveBlocks` → `triggerAmnesia`（偵測到挑戰時 `throw 'WAF blocked'`）。
- **常駐分頁的死因不只斷線**：scout profile 有 6–12 小時定期失憶（`triggerAmnesia` 關瀏覽器刪 profile）、scheduler 遇 `Target closed` 類錯誤也會 `resetBrowser('scout')`。`getScoutPage` 每次取用都要驗活（browser connected 且 `!page.isClosed()`）並自動重建；重建時記得補上 `withPage` 裡 cookie-accept 的 `evaluateOnNewDocument` 注入（建議抽成共用函式）。

## 檔案層級變更清單

1. **[src/scrapers/tixcraft.js](src/scrapers/tixcraft.js)（新增為主，不動搶票段）**
   - 新增 `parseAreaHtml(html, baseUrl)`：用 cheerio 解析 HTML 字串，套用與 `parseAreaList` 相同的可購／售完／輪椅判斷規則，回傳 sections（不含 `markRandomAvailable`，偵測用不到選區）。重用既有 `classifySection` / `summarize`。注意 **`href` 語意差異**：DOM 的 `anchor.href` 是解析後的絕對 URL、cheerio 的 `attr('href')` 是原始（可能相對的）屬性值，需用 `new URL(href, baseUrl)` 轉成絕對，否則 parity 測試與前端顯示會對不上。
   - 新增 `fetchAreaHtml(page, url)`：in-context fetch 包裝（上方步驟 2）——回傳 `{ status, html }`、內建 10s AbortSignal 逾時、fetch 前先比對 origin。
   - 新增 `htmlLooksBlocked(html)`：以字串比對版的挑戰頁偵測（對應 `detectBlockPage` 規則）。
   - 新增 `scrapeTixcraftFast(url, site)`：組合「常駐分頁 → fetch → 解析 → 回傳」與 fallback；**保留**與現行 `scrapeTixcraft` 相同的自動搶票觸發邏輯（`availableCount > 0 && tixuisid` → fire-and-forget `attemptAddToCart`，含 `activeCartTasks` 防重複、背景排隊中提前返回）。
   - `attemptAddToCart`／`keepKillerWarm` 等搶票、保溫鏈路**完全不動**；`scrapeTixcraft`（渲染版）整段保留，作為 `detectionMode: 'render'` 的退路。
2. **[src/scrapers/browser.js](src/scrapers/browser.js)**
   - 新增 `getScoutPage(origin)`：取得或建立一個常駐（keep-alive）Scout 分頁並維持在指定 origin，供重複 fetch 使用；沿用 `getBrowser('scout')`。
     - 以 **per-origin 分頁快取**實作：同時監控多個不同子網域的活動時，單一分頁每輪都得跨 origin 真實導航，fast 模式會退化回渲染速度；一個 origin 一顆常駐分頁才能全數受益。
     - 每次取用**驗活並自動重建**（死因見「退場／韌性」：定期失憶、resetBrowser、斷線），重建時補 cookie-accept 注入。
3. **[src/scrapers/index.js](src/scrapers/index.js)**
   - `resolveScraper` 對 tixcraft 改指向 `scrapeTixcraftFast`（或加 `detectionMode` 分派）。
4. **[src/scheduler.js](src/scheduler.js)**
   - 偵測迴圈維持不變（仍 `scrapeSite` → `notifyForSiteResult`）；確認新路徑回傳結構與 `state.setSiteResult`／通知相容。`fetchCaptcha` 偷圖那段與本計畫無關，可保留或關閉（建議關閉，非必要）。
5. **[src/config/settings.js](src/config/settings.js)（選配）**
   - 新增 `detectionMode: 'fast' | 'render'`（預設 `fast`），保留一鍵切回舊渲染偵測作為安全開關。
   - 注意 `patchSettings` 是**逐 key 白名單**（settings.js:47 起），光加進 `DEFAULTS` 存不進去——要在 `patchSettings` 一併加上 `detectionMode` 的處理；若要在 UI／`api.js` 露出，也要跟著加。
6. **相依套件**：新增 `cheerio`（Node 端輕量 HTML 解析，讓偵測解析可脫離瀏覽器、可單元測試）。

## 分階段落地（每階段可獨立驗證）

1. **抽出並移植解析邏輯**：實作 `parseAreaHtml` + cheerio，對照 `parseAreaList` 規則。→ 驗證：用存檔的區域頁 HTML fixture（售完／有票／輪椅）做 Node 單元測試，結果需與現行 DOM 版一致。
2. **in-context fetch 打通**：`getScoutPage` + `fetchAreaHtml`，先只 log 抓回的 HTML 長度與解析結果，不改通知。→ 驗證：對真實區域頁跑一輪，比對 fast-fetch 解析 vs 現行渲染解析的 summary 是否一致（parity）。
3. **接上主迴圈 + fallback**：`scrapeTixcraftFast` 併入 `resolveScraper`，挑戰頁時退回渲染。→ 驗證：正常時走 fetch、被擋時自動退回渲染並恢復。
4. **延遲量測**：仿 [test/scout-nav-bench.js](test/scout-nav-bench.js) 比較 render vs fast 每輪耗時，確認顯著下降。

## 驗證方式（end-to-end）

- **單元**：`node test/parse-area-html.test.js`（新增，browserless）驗證 `parseAreaHtml` 對各種 HTML 的分類正確。
- **整合／parity**：常駐主程式（:3000）不重啟現有實例的前提下，另跑一支對照腳本，對同一啟用場次同時用兩法解析，比對 summary 一致。
- **延遲 bench**：render vs fast 每輪耗時對照。
- **韌性**：手動製造挑戰頁（冷啟動）確認自動退回渲染並刷新 cf_clearance 後恢復 fetch 模式。
- **通知＋搶票**：確認偵測到有票時仍正常推 LINE／Telegram，且**自動搶票照舊觸發**（Killer 出動、cartResult 通知不受影響）。
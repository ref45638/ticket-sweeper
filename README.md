# Ticket Sweeper Bot

本地端清票監控工具。為了解決各大售票系統（如 tixcraft）越來越嚴格的 Cloudflare Turnstile 等 WAF 防護，本專案改用 `puppeteer-real-browser` 進行自動化瀏覽，並導入了「信用培養與定期失憶」等進階反爬蟲對策。可透過 LINE / Telegram 推播空位，並附有簡易 Web UI 方便管理監控清單。

## ✨ 核心特色

- **抗 WAF 封鎖**：採用 `puppeteer-real-browser`，自動處理 WebGL/Canvas 等底層指紋特徵。
- **動態行為模擬**：每次抓取前會進行隨機滾動與等待，模擬真實人類瀏覽行為。
- **智慧排程**：
  - **一般時段**：以 `SCRAPE_INTERVAL_MS` 為基礎，每輪自動加上 **±15 秒 jitter**（避免固定節奏）。
  - **凌晨降頻**：每日 **03:00–09:00**（本機時區）自動改為 **5 分鐘**基礎間隔，避免夜間過度活躍。
- **定期失憶 (Session Rotation)**：
  - 每個 Browser Profile 擁有獨立的 6~12 小時隨機生命週期。
  - 生命週期結束，或偵測到「連續 3 次被 WAF 阻擋（403/Turnstile 逾時）」時，會自動清除 Profile、更換 Viewport 解析度並重置特徵，避免被標記為惡意連線。
- **通知與介面**：支援 LINE Notify / Telegram，並提供 `http://localhost:3000` 視覺化管理監控站點。

## 🚀 需求

- Node.js 18+
- Chromium（由 Puppeteer 自動下載）

## 📦 安裝與啟動

```bash
npm install
cp .env.example .env
# 請編輯 .env 填入需要的 Token 與設定
npm start
```

- **Web UI 管理介面**：`http://localhost:3000`
- **查看目前狀態**：`GET http://localhost:3000/api/status`

## ⚙️ 環境變數 (`.env`)

| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | HTTP 埠 | `3000` |
| `SCRAPE_INTERVAL_MS` | 基礎輪詢間隔（毫秒）。實際排程會加上隨機 jitter；凌晨會自動降頻 | `60000` |
| `NOTIFY_COOLDOWN_MS` | 同一票區的重複通知冷卻時間（預設 10 分鐘） | `600000` |
| `BROWSER_HEADLESS` | 隱藏瀏覽器視窗。若設為 `false` 會將視窗移至螢幕外 | `false` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot token | — |
| `LINE_TARGET_ID` | LINE 推播對象 userId | — |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token | — |
| `TELEGRAM_CHAT_ID` | Telegram chat id | — |

## 🎫 支援站點

- **拓元 tixcraft**：URL 符合 `tixcraft.com/ticket/area/`
- *註：系統會自動略過名稱含「輪椅」「身障」的特殊席次，以確保一般購票需求。*

## 🔌 API 參考

- **`GET /api/status`**：排程狀態、下一次執行時間、通知通道狀態、支援的 scraper 列表。
- **`GET /api/results`**：最新爬取結果（以站點清單為主，合併目前記憶體中的抓取結果）。
- **`GET /api/sites`**：列出監控清單。
- **`POST /api/sites`**：新增監控（body：`{ label, url, scraperId?, enabled? }`）。
- **`PATCH /api/sites/:id`**：更新監控設定。
- **`DELETE /api/sites/:id`**：刪除特定監控。
- **`POST /api/sites/:id/scrape`**：手動觸發單一站點抓取，強制執行一次測試。

## ⚠️ 免責聲明

本工具僅供個人監控票況與技術研究使用，請遵守各售票網站服務條款，**請勿用於惡意爬蟲或自動下單**。任何因使用本工具造成的帳號封鎖或法律問題，需由使用者自行承擔。

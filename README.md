# Ticket Sweeper Bot

本地端清票監控：使用 Puppeteer（stealth）輪詢購票頁、解析剩餘票數，並可透過 LINE / Telegram 推播，附簡易 Web UI 方便管理監控清單。

## 需求

- Node.js 18+
- Chromium（由 Puppeteer 自動下載）

## 安裝與啟動

```bash
npm install
cp .env.example .env
# 選填：LINE / Telegram token
npm start
```

- **Web UI**：`http://localhost:3000`
- **API**：`GET http://localhost:3000/api/status`、`GET http://localhost:3000/api/results`

## 排程行為（重要）

- **一般時段**：以 `SCRAPE_INTERVAL_MS` 為基礎，每輪會加上 **±15 秒 jitter**（避免固定節奏）。
- **凌晨降頻**（本機時區）：每日 **03:00–09:00** 會自動改為 **5 分鐘**為基礎間隔，同樣有 **±15 秒 jitter**。
- 若上一輪尚未結束，會略過本次觸發（避免重疊執行）。

## 監控清單（sites）

- 監控站點清單存放在 `src/sites.json`。
- 你可以透過 Web UI 新增/刪除/啟用，或直接用 API 管理（見下方）。

## 環境變數

| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | HTTP 埠 | `3000` |
| `SCRAPE_INTERVAL_MS` | 基礎輪詢間隔（毫秒）。實際排程會加上 jitter；凌晨 03:00–09:00 會自動降頻 | `60000` |
| `NOTIFY_COOLDOWN_MS` | 同一區域通知冷卻 | `600000` |
| `PUPPETEER_HEADLESS` | 無頭瀏覽器 | `true` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot token | — |
| `LINE_TARGET_ID` | LINE 推播對象 userId | — |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token | — |
| `TELEGRAM_CHAT_ID` | Telegram chat id | — |

## 支援站點

- **tixcraft**：URL 符合 `tixcraft.com/ticket/area/`
- 自動略過名稱含「輪椅」「身障」的席次

## API

- **`GET /api/status`**：排程狀態、下一次執行時間、通知通道狀態、支援的 scraper 列表。
- **`GET /api/results`**：最新爬取結果（以站點清單為主，合併目前記憶體中的抓取結果）。回傳格式：

  - `updatedAt`: ISO 時間字串
  - `sites[]`: 每個站點包含 `id`、`label`、`url`、`enabled`、`scraperId`、`lastScrapedAt`、`error`、`sections[]`、`summary`

- **`GET /api/sites`**：列出監控清單（並包含 `lastScrapedAt` / `lastError`）。
- **`POST /api/sites`**：新增監控（body：`{ label, url, scraperId?, enabled? }`）。
- **`PATCH /api/sites/:id`**：更新監控（`label` / `url` / `scraperId` / `enabled`）。
- **`DELETE /api/sites/:id`**：刪除監控。
- **`POST /api/sites/:id/scrape`**：手動觸發單一站點抓取。

## 免責

本工具僅供個人監控票況，請遵守購票網站服務條款，勿用於惡意爬蟲或自動下單。

# Ticket Sweeper Bot

本地端清票監控：每分鐘用 Puppeteer（stealth）輪詢購票頁、解析剩餘票數，並可透過 LINE / Telegram 推播。

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

- Web UI：<http://localhost:3000>
- API：`GET http://localhost:3000/api/results`

## 環境變數

| 變數 | 說明 | 預設 |
|------|------|------|
| `PORT` | HTTP 埠 | `3000` |
| `SCRAPE_INTERVAL_MS` | 輪詢間隔（毫秒），對齊牆鐘整點（如 60s → 每分鐘 :00） | `60000` |
| `NOTIFY_COOLDOWN_MS` | 同一區域通知冷卻 | `600000` |
| `PUPPETEER_HEADLESS` | 無頭瀏覽器 | `true` |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot token | — |
| `LINE_TARGET_ID` | LINE 推播對象 userId | — |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token | — |
| `TELEGRAM_CHAT_ID` | Telegram chat id | — |

## 支援站點

- **tixcraft**：URL 含 `tixcraft.com/ticket/area/`
- 自動略過名稱含「輪椅」「身障」的席次

## API

- `GET /api/status` — 排程與通知通道狀態
- `GET /api/results` — 最新爬取結果（JSON）
- `GET|POST /api/sites` — 監控清單
- `PATCH|DELETE /api/sites/:id`
- `POST /api/sites/:id/scrape` — 手動抓取

## 免責

本工具僅供個人監控票況，請遵守購票網站服務條款，勿用於惡意爬蟲或自動下單。

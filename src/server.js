const express = require('express');
const config = require('./config/env');
const apiRouter = require('./routes/api');
const webRouter = require('./routes/web');
const scheduler = require('./scheduler');
const log = require('./logger');
const telegramBot = require('./telegram/bot');

const app = express();

const webhookRouter = require('./routes/webhook');
app.use('/api/webhook', webhookRouter);

app.use(express.json());
app.use('/api', apiRouter);
app.use(webRouter);

app.use((err, _req, res, _next) => {
  log.error('server', '未處理錯誤', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(config.port, async () => {
  log.info('server', `Ticket Sweeper 啟動 http://localhost:${config.port}`);
  log.info('server', `輪詢間隔 ${config.scrapeIntervalMs / 1000}s，通知冷卻 ${config.notifyCooldownMs / 1000}s`);
  log.info(
    'server',
    `通知通道 LINE=${config.line.enabled() ? 'ON' : 'OFF'} Telegram=${config.telegram.enabled() ? 'ON' : 'OFF'}`
  );

  if (config.ngrokToken) {
    try {
      const ngrok = require('@ngrok/ngrok');
      const listener = await ngrok.forward({
        addr: config.port,
        authtoken: config.ngrokToken,
      });
      log.info('server', `ngrok 已經啟動，您的 LINE Webhook URL 網址為：${listener.url()}/api/webhook`);
      log.info('server', `請將上方網址貼至 LINE Developers Console 的 Webhook URL 欄位並開啟 Use webhook。`);
      
      // 用 Telegraf 註冊 Telegram Webhook
      if (config.telegram.botToken) {
        try {
          const webhookUrl = `${listener.url()}/api/telegram_webhook`;
          const handler = await telegramBot.launchWebhook(webhookUrl);
          if (handler) {
            app.use('/api/telegram_webhook', handler);
            log.info('server', '已成功透過 Telegraf 註冊 Telegram Webhook');
          }
        } catch (e) {
          log.error('server', `Telegram Webhook 註冊失敗: ${e.message}`);
        }
      }
    } catch (e) {
      log.error('server', 'ngrok 啟動或 Webhook 註冊失敗', e);
    }
  }

  scheduler.startScheduler();
});

function shutdown() {
  log.info('server', '正在關閉…');
  telegramBot.stop();
  scheduler.stopScheduler();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

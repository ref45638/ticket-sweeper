const express = require('express');
const config = require('./config/env');
const apiRouter = require('./routes/api');
const webRouter = require('./routes/web');
const scheduler = require('./scheduler');
const log = require('./logger');

const app = express();

app.use(express.json());
app.use('/api', apiRouter);
app.use(webRouter);

app.use((err, _req, res, _next) => {
  log.error('server', '未處理錯誤', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const server = app.listen(config.port, () => {
  log.info('server', `Ticket Sweeper 啟動 http://localhost:${config.port}`);
  log.info('server', `輪詢間隔 ${config.scrapeIntervalMs / 1000}s，通知冷卻 ${config.notifyCooldownMs / 1000}s`);
  log.info(
    'server',
    `通知通道 LINE=${config.line.enabled() ? 'ON' : 'OFF'} Telegram=${config.telegram.enabled() ? 'ON' : 'OFF'}`
  );
  scheduler.startScheduler();
});

function shutdown() {
  log.info('server', '正在關閉…');
  scheduler.stopScheduler();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

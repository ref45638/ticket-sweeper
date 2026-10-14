const { Telegraf } = require('telegraf');
const config = require('../config/env');
const log = require('../logger');

let bot = null;

function getBot() {
  if (!bot && config.telegram.botToken) {
    bot = new Telegraf(config.telegram.botToken);

    // 全局 error handler
    bot.catch((err, ctx) => {
      log.error('telegram-bot', `Update ${ctx.updateType} 錯誤`, err.message);
    });

    // 註冊指令與 handler
    require('./commands/start')(bot);
    require('./commands/list')(bot);
    require('./commands/add')(bot);
    require('./commands/set')(bot);
    require('./handlers/actions')(bot);

    // 未知指令 fallback
    bot.on('text', (ctx) => {
      const text = ctx.message.text.trim();
      if (text.startsWith('/')) {
        ctx.reply('未知指令。請輸入 /help 或 /指令 來查看可用功能。');
      }
      // 一般聊天訊息不回應
    });
  }
  return bot;
}

/**
 * 用 webhook 模式啟動 bot（供 server.js 呼叫）。
 * @param {string} webhookUrl — 完整的 webhook URL（含 path）
 * @returns {import('express').RequestHandler} Express middleware
 */
async function launchWebhook(webhookUrl) {
  const b = getBot();
  if (!b) return null;

  await b.telegram.setWebhook(webhookUrl);
  log.info('telegram-bot', `已註冊 Telegram Webhook: ${webhookUrl}`);
  return b.webhookCallback('/');
}

function stop() {
  if (bot) {
    bot.stop('shutdown');
    bot = null;
  }
}

module.exports = { getBot, launchWebhook, stop };

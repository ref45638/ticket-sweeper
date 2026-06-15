const express = require('express');
const config = require('../config/env');
const log = require('../logger');
const { processCommand } = require('../services/commandHandler');
const telegramNotifier = require('../notifier/telegram');

const router = express.Router();

// 若未設定齊全，給個空的路由避免報錯
if (!config.telegram.enabled()) {
  router.post('/', (req, res) => res.status(200).send('Telegram Bot Not Configured'));
  module.exports = router;
  return;
}

router.post('/', express.json(), async (req, res) => {
  try {
    const update = req.body || {};
    
    // 只處理有文字訊息的 update
    if (!update.message || !update.message.text) {
      return res.status(200).send('OK');
    }

    const text = update.message.text.trim();
    const chatId = update.message.chat.id;

    const replyText = await processCommand(text);
    if (replyText) {
      await telegramNotifier.send(replyText, chatId);
    }

    res.status(200).send('OK');
  } catch (err) {
    log.error('webhook', 'Telegram Webhook Error', err);
    res.status(500).end();
  }
});

module.exports = router;

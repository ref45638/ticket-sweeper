const express = require('express');
const line = require('@line/bot-sdk');
const config = require('../config/env');
const sitesStore = require('../config/sites');
const settingsStore = require('../config/settings');
const log = require('../logger');

const router = express.Router();

// 確保有設定 Token 與 Secret 才能使用 Webhook
const lineConfig = {
  channelAccessToken: config.line.token,
  channelSecret: config.line.channelSecret,
};

// 若未設定齊全，給個空的路由避免報錯
if (!config.line.botEnabled()) {
  router.post('/', (req, res) => res.status(200).send('LINE Bot Not Configured'));
  module.exports = router;
  return;
}

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// Middleware 驗證 LINE 的簽章
router.post('/', line.middleware(lineConfig), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    log.error('webhook', 'LINE Webhook Error', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const text = event.message.text.trim();
  const replyToken = event.replyToken;

  // 印出訊息來源，方便取得 Group ID 或 User ID
  // log.info('webhook', `收到訊息來源: ${JSON.stringify(event.source)}`);

  try {
    const { processCommand } = require('../services/commandHandler');
    const replyText = await processCommand(text);
    if (replyText) {
      await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: replyText }],
      });
    }
  } catch (err) {
    log.error('webhook', 'Process Command Error', err);
    await client.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `執行發生錯誤：${err.message}` }],
    });
  }
}

module.exports = router;

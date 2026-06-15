const config = require('../config/env');

function isEnabled() {
  return config.telegram.enabled();
}

async function send(text, targetChatId = null) {
  if (!isEnabled()) return { skipped: true, channel: 'telegram' };

  const chatId = targetChatId || config.telegram.chatId;

  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }

  return { ok: true, channel: 'telegram' };
}

module.exports = { isEnabled, send };

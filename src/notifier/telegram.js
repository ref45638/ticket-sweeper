const config = require('../config/env');

function isEnabled() {
  return config.telegram.enabled();
}

/**
 * 取得 Telegraf bot 的 telegram 實例。
 * 延遲載入避免循環依賴。
 */
function getTelegram() {
  try {
    const { getBot } = require('../telegram/bot');
    const bot = getBot();
    return bot ? bot.telegram : null;
  } catch {
    return null;
  }
}

async function send(text, targetChatId = null, options = {}) {
  if (!isEnabled()) return { skipped: true, channel: 'telegram' };

  const chatId = targetChatId || config.telegram.chatId;
  const tg = getTelegram();

  if (tg) {
    // 優先使用 Telegraf API
    await tg.sendMessage(chatId, text, {
      parse_mode: options.parse_mode || undefined,
      disable_web_page_preview: false,
    });
  } else {
    // Fallback: 直接呼叫 API（bot 尚未初始化時）
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
  }

  return { ok: true, channel: 'telegram' };
}

module.exports = { isEnabled, send };

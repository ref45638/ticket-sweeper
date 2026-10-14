const config = require('../../config/env');
const log = require('../../logger');

/**
 * 檢查是否有編輯/刪除等進階權限
 * 允許 TELEGRAM_CHAT_ID 設為多組 (以逗號分隔)
 */
module.exports = function checkAdmin(ctx, next) {
  const allowedStr = config.telegram.chatId || '';
  const allowedChatIds = allowedStr.split(',').map(id => id.trim()).filter(Boolean);

  if (allowedChatIds.length === 0) return next(); // 未設定就不限制

  const chatId = String(ctx.chat?.id || '');
  if (chatId && !allowedChatIds.includes(chatId)) {
    log.warn('telegram-bot', `拒絕未授權操作: ${chatId}`);
    
    if (ctx.callbackQuery) {
      return ctx.answerCbQuery('⛔ 你沒有權限執行此操作。', { show_alert: true });
    }
    return ctx.reply('⛔ 你沒有權限執行這個操作。');
  }
  return next();
};

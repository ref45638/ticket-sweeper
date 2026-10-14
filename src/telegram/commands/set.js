const { Markup } = require('telegraf');
const settingsStore = require('../../config/settings');
const checkAdmin = require('../middleware/chatGuard');

module.exports = function setCommand(bot) {
  // /set（無參數）→ 顯示設定選單
  // /set TIXUISID [值] → 直接設定（因為值是文字輸入，不適合用按鈕）
  // /set help → 顯示教學
  bot.command('set', checkAdmin, async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const key = args[0];
    const value = args[1];

    // 無參數或 help → 顯示設定選單
    if (!key || key.toLowerCase() === 'help') {
      return showSettingsMenu(ctx);
    }

    // TIXUISID 只能用文字設定
    if (key.toUpperCase() === 'TIXUISID') {
      if (!value) return ctx.reply('❌ 請提供 TIXUISID 的值。');
      try {
        await settingsStore.patchSettings({ tixuisid: value });
        return ctx.reply(`✅ 成功設定 TIXUISID = <code>${escapeHtml(value)}</code>`, { parse_mode: 'HTML' });
      } catch (e) {
        return ctx.reply(`❌ 設定失敗：${e.message}`);
      }
    }

    return ctx.reply('❌ 未知的設定鍵值。\n請輸入 /set 查看設定選單。');
  });
};

async function showSettingsMenu(ctx) {
  const data = await settingsStore.getSettings();
  const unattended = Boolean(data.unattendedMode);
  const warm = Boolean(data.warmKiller);

  const text =
    '⚙️ <b>設定選單</b>\n\n' +
    `🚪 離座模式：${unattended ? '✅ 開啟' : '❌ 關閉'}\n` +
    `🔥 Killer 保溫：${warm ? '✅ 開啟' : '❌ 關閉'}\n\n` +
    '💡 TIXUISID 請用文字指令設定：\n' +
    '<code>/set TIXUISID [你的值]</code>';

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          unattended ? '🚪 離座模式：關閉' : '🚪 離座模式：開啟',
          unattended ? 'set_unattended_off' : 'set_unattended_on'
        ),
      ],
      [
        Markup.button.callback(
          warm ? '🔥 保溫：關閉' : '🔥 保溫：開啟',
          warm ? 'set_warm_off' : 'set_warm_on'
        ),
      ],
    ]),
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports.showSettingsMenu = showSettingsMenu;

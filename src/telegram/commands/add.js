const sitesStore = require('../../config/sites');
const checkAdmin = require('../middleware/chatGuard');

module.exports = function addCommand(bot) {
  bot.command(['add', '新增'], checkAdmin, async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const label = args[0];
    const url = args[1];

    if (!label || !url) {
      return ctx.reply(
        '❌ 格式錯誤，請輸入：\n<code>/add [名稱] [網址]</code>\n\n' +
        '例如：\n<code>/add 五月天 https://tixcraft.com/activity/game/24_mayday</code>',
        { parse_mode: 'HTML' }
      );
    }

    if (!url.startsWith('http')) {
      return ctx.reply('❌ 網址格式錯誤，必須包含 http 或 https');
    }

    try {
      await sitesStore.createSite({ label, url, enabled: true });
      await ctx.reply(`✨ 成功新增並啟動監控：<b>${escapeHtml(label)}</b>`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply(`❌ 新增失敗：${e.message}`);
    }
  });

  // URL 快捷偵測
  bot.hears(/^https:\/\/tixcraft\.com\/activity\//, checkAdmin, (ctx) => {
    const url = ctx.message.text.trim();
    ctx.reply(
      '這看起來是拓元活動網址！\n若要新增至監控，請輸入：\n' +
      `<code>/add [名稱] ${escapeHtml(url)}</code>`,
      { parse_mode: 'HTML' }
    );
  });
};

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

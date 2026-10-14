const { Markup } = require('telegraf');
const sitesStore = require('../../config/sites');

const SITES_PER_PAGE = 5;

function buildSiteListMessage(sites, page = 0) {
  if (sites.length === 0) {
    return {
      text: '📋 目前沒有任何監控站點。\n\n輸入 /add [名稱] [網址] 來加入。',
      keyboard: null,
    };
  }

  const totalPages = Math.ceil(sites.length / SITES_PER_PAGE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * SITES_PER_PAGE;
  const pageSites = sites.slice(start, start + SITES_PER_PAGE);

  const lines = pageSites.map((s, idx) => {
    const num = start + idx + 1;
    const status = s.enabled ? '🟢' : '🔴';
    return `${num}. ${status} <b>${escapeHtml(s.label)}</b>\n   ${escapeHtml(s.url)}`;
  });

  const text = `📋 <b>監控列表</b>（${safePage + 1}/${totalPages}）\n\n${lines.join('\n\n')}`;

  // 每個站點一排按鈕：啟動/停止 + 刪除
  const siteButtons = pageSites.map((s) => {
    const toggleBtn = s.enabled
      ? Markup.button.callback('⏸ 停止', `site_stop_${s.id}`)
      : Markup.button.callback('▶️ 啟動', `site_start_${s.id}`);
    const deleteBtn = Markup.button.callback('🗑 刪除', `site_delete_${s.id}`);
    return [toggleBtn, deleteBtn];
  });

  // 分頁按鈕
  const navRow = [];
  if (safePage > 0) navRow.push(Markup.button.callback('◀️ 上一頁', `page_${safePage - 1}`));
  if (safePage < totalPages - 1) navRow.push(Markup.button.callback('▶️ 下一頁', `page_${safePage + 1}`));

  const rows = [...siteButtons];
  if (navRow.length > 0) rows.push(navRow);

  return {
    text,
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = function listCommand(bot) {
  bot.command(['list', '清單'], async (ctx) => {
    const sites = await sitesStore.listSites();
    const { text, keyboard } = buildSiteListMessage(sites, 0);
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...(keyboard ? keyboard : {}),
    });
  });
};

// 匯出給 actions handler 使用
module.exports.buildSiteListMessage = buildSiteListMessage;

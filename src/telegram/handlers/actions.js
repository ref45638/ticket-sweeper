const { Markup } = require('telegraf');
const sitesStore = require('../../config/sites');
const settingsStore = require('../../config/settings');
const { buildSiteListMessage } = require('../commands/list');
const { showSettingsMenu } = require('../commands/set');
const checkAdmin = require('../middleware/chatGuard');

module.exports = function actionsHandler(bot) {
  // ===== 站點控制 =====

  bot.action(/^site_start_(.+)$/, checkAdmin, async (ctx) => {
    const siteId = ctx.match[1];
    const site = await sitesStore.getSiteById(siteId);
    if (!site) return ctx.answerCbQuery('找不到該站點');

    await sitesStore.updateSite(siteId, { enabled: true });
    await ctx.answerCbQuery(`✅ 已啟動：${site.label}`);
    await refreshSiteList(ctx);
  });

  bot.action(/^site_stop_(.+)$/, checkAdmin, async (ctx) => {
    const siteId = ctx.match[1];
    const site = await sitesStore.getSiteById(siteId);
    if (!site) return ctx.answerCbQuery('找不到該站點');

    await sitesStore.updateSite(siteId, { enabled: false });
    await ctx.answerCbQuery(`⏸️ 已停止：${site.label}`);
    await refreshSiteList(ctx);
  });

  // 刪除 → 先確認
  bot.action(/^site_delete_(.+)$/, checkAdmin, async (ctx) => {
    const siteId = ctx.match[1];
    const site = await sitesStore.getSiteById(siteId);
    if (!site) return ctx.answerCbQuery('找不到該站點');

    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⚠️ 確定要刪除 <b>${escapeHtml(site.label)}</b> 嗎？`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ 確認刪除', `site_confirm_delete_${siteId}`),
            Markup.button.callback('❌ 取消', 'action_cancel'),
          ],
        ]),
      }
    );
  });

  bot.action(/^site_confirm_delete_(.+)$/, checkAdmin, async (ctx) => {
    const siteId = ctx.match[1];
    const site = await sitesStore.getSiteById(siteId);
    if (!site) return ctx.answerCbQuery('找不到該站點');

    await sitesStore.deleteSite(siteId);
    await ctx.answerCbQuery(`🗑️ 已刪除：${site.label}`);
    await refreshSiteList(ctx);
  });

  // 取消操作 → 回到站點清單
  bot.action('action_cancel', checkAdmin, async (ctx) => {
    await ctx.answerCbQuery('已取消');
    await refreshSiteList(ctx);
  });

  // ===== 分頁 =====

  bot.action(/^page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await refreshSiteList(ctx, page);
  });

  // ===== 設定開關 =====

  bot.action(/^set_unattended_(on|off)$/, checkAdmin, async (ctx) => {
    const enabled = ctx.match[1] === 'on';
    await settingsStore.patchSettings({ unattendedMode: enabled });
    await ctx.answerCbQuery(enabled ? '🚪 已開啟離座模式' : '🪑 已關閉離座模式');
    // 刷新設定選單
    await showSettingsMenu(ctx);
    // 刪掉舊訊息（設定選單）
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });

  bot.action(/^set_warm_(on|off)$/, checkAdmin, async (ctx) => {
    const enabled = ctx.match[1] === 'on';
    await settingsStore.patchSettings({ warmKiller: enabled });
    await ctx.answerCbQuery(enabled ? '🔥 已開啟保溫' : '❄️ 已關閉保溫');
    await showSettingsMenu(ctx);
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
  });
};

/**
 * 刷新站點清單訊息（編輯既有訊息）。
 */
async function refreshSiteList(ctx, page = 0) {
  const sites = await sitesStore.listSites();
  const { text, keyboard } = buildSiteListMessage(sites, page);
  try {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      ...(keyboard ? keyboard : {}),
    });
  } catch {
    // editMessageText 可能因為內容相同而報錯，忽略
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

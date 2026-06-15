const sitesStore = require('../config/sites');
const settingsStore = require('../config/settings');

async function processCommand(text) {
  // 網址快捷新增 (保留不需斜線的功能，如果需要強制斜線也可以改掉，但通常貼網址很直覺)
  if (text.startsWith('https://tixcraft.com/activity/')) {
    return `這看起來是拓元活動網址！\n若要新增至監控，請輸入：\n/新增 [名稱] ${text}`;
  }

  // 如果不是以斜線開頭，就完全不反應 (忽略一般聊天訊息)
  if (!text.startsWith('/')) {
    return null;
  }

  // 移除斜線，並以空白分割
  const parts = text.substring(1).trim().split(/\s+/);
  let command = parts[0].toLowerCase();

  // 處理 Telegram 群組中指令可能會帶有 @botname 的後綴 (例如 /help@my_bot)
  if (command.includes('@')) {
    command = command.split('@')[0];
  }

  // 1.1 列出站點
  if (command === '清單' || command === 'list') {
    const sites = await sitesStore.listSites();
    if (sites.length === 0) {
      return '目前沒有任何監控站點。\n您可以輸入「/新增 [名稱] [網址]」來加入。';
    }
    const listStr = sites
      .map((s, idx) => {
        const status = s.enabled ? '🟢 執行中' : '🔴 已停止';
        return `${idx + 1}. [${status}] ${s.label}\n   ${s.url}`;
      })
      .join('\n\n');

    return `📋 監控列表：\n\n${listStr}\n\n💡 提示：您可以輸入「/start 1」、「/stop 1」或「/delete 1」來管理對應項目。`;
  }

  // 1.2 控制與刪除
  if (['啟動', '停止', '刪除', 'start', 'stop', 'delete'].includes(command)) {
    const indexStr = parts[1];
    if (!indexStr) return `請指定編號，例如：「/${command} 1」`;

    const index = parseInt(indexStr, 10) - 1;
    const sites = await sitesStore.listSites();

    if (isNaN(index) || index < 0 || index >= sites.length) {
      return `找不到編號 ${indexStr} 的站點。請輸入「/清單」確認編號。`;
    }

    const site = sites[index];

    if (command === '啟動' || command === 'start') {
      await sitesStore.updateSite(site.id, { enabled: true });
      return `✅ 已啟動：${site.label}`;
    } else if (command === '停止' || command === 'stop') {
      await sitesStore.updateSite(site.id, { enabled: false });
      return `⏸️ 已停止：${site.label}`;
    } else if (command === '刪除' || command === 'delete') {
      await sitesStore.deleteSite(site.id);
      return `🗑️ 已刪除：${site.label}`;
    }
  }

  // 1.3 新增站點
  if (command === '新增' || command === 'add') {
    const label = parts[1];
    const url = parts[2];

    if (!label || !url) {
      return `❌ 格式錯誤，請輸入：/新增 [名稱] [網址]\n例如：/新增 五月天 https://tixcraft.com/activity/game/24_mayday`;
    }

    if (!url.startsWith('http')) {
      return '❌ 網址格式錯誤，必須包含 http 或 https';
    }

    try {
      await sitesStore.createSite({ label, url, enabled: true });
      return `✨ 成功新增並啟動監控：${label}`;
    } catch (e) {
      return `❌ 新增失敗：${e.message}`;
    }
  }

  // 1.4 設定指令
  if (command === 'set') {
    const key = parts[1];
    const value = parts[2];

    if (!key || key.toLowerCase() === 'help') {
      return (
        '⚙️ 設定指令教學：\n\n' +
        '- /set TIXUISID [值]：設定拓元登入的 Session ID\n' +
        '  (例如: /set TIXUISID odkqwodkwqod)'
      );
    }

    if (key.toUpperCase() === 'TIXUISID') {
      if (!value) {
        return '❌ 請提供 TIXUISID 的值。';
      }
      try {
        await settingsStore.patchSettings({ tixuisid: value });
        return `✅ 成功設定 TIXUISID = ${value}`;
      } catch (e) {
        return `❌ 設定失敗：${e.message}`;
      }
    }

    return `❌ 未知的設定鍵值：${key}\n請輸入 /set help 查看可用設定。`;
  }

  // 1.5 幫助與指令清單
  if (['help', '指令', '幫助'].includes(command)) {
    return (
      '🤖 Ticket Sweeper 機器人可用指令：\n\n' +
      '📌 站點管理\n' +
      '- /list (或 /清單)：查看所有監控站點\n' +
      '- /add (或 /新增) [名稱] [網址]：加入新監控\n' +
      '   (例如: /add 五月天 https://...)\n\n' +
      '⚙️ 控制指令\n' +
      '- /start (或 /啟動) [編號]\n' +
      '- /stop (或 /停止) [編號]\n' +
      '- /delete (或 /刪除) [編號]\n' +
      '   (編號請先使用 /清單 查詢)\n\n' +
      '🔧 設定指令\n' +
      '- /set help：查看設定教學'
    );
  }

  return '未知指令。請輸入 /help 或是 /指令 來查看可用功能。';
}

module.exports = {
  processCommand,
};

module.exports = function startCommand(bot) {
  const helpText =
    '🤖 <b>Ticket Sweeper</b> 可用指令：\n\n' +
    '📌 <b>站點管理</b>\n' +
    '• /list（/清單）— 查看所有監控站點\n' +
    '• /add（/新增）[名稱] [網址] — 加入新監控\n\n' +
    '⚙️ <b>設定</b>\n' +
    '• /set — 開啟設定選單\n\n' +
    '❓ <b>其他</b>\n' +
    '• /help（/指令）— 顯示此說明';

  bot.start((ctx) => ctx.reply(
    '👋 歡迎使用 <b>Ticket Sweeper</b>！\n\n' +
    '我會自動幫你監控拓元售票，一有票就即時通知。\n\n' +
    '輸入 /list 查看監控清單，或 /help 查看所有指令。',
    { parse_mode: 'HTML' }
  ));

  bot.command(['help', '指令', '幫助'], (ctx) =>
    ctx.reply(helpText, { parse_mode: 'HTML' })
  );
};

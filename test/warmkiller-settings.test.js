/**
 * 驗證 Killer 保溫(warmKiller) 設定的「開關」與「LINE/Telegram 指令」都能真正切換。
 * 會先備份 src/settings.json，跑完還原，不更動你的實際設定。
 * 不需瀏覽器。執行：node test/warmkiller-settings.test.js
 */
const fs = require('fs');
const path = require('path');
const settings = require('../src/config/settings');
const { processCommand } = require('../src/services/commandHandler');

const SETTINGS = path.join(__dirname, '../src/settings.json');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};
const warmNow = async () => (await settings.getSettings()).warmKiller;

(async () => {
  const backup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;
  try {
    console.log('【預設值】');
    // 用一份不含 warmKiller 的 settings 驗證 DEFAULTS（暫時寫入再還原）
    await settings.patchSettings({ warmKiller: false });
    check('預設/關閉時 warmKiller=false', (await warmNow()) === false);

    console.log('\n【Web UI 開關 → patchSettings】');
    await settings.patchSettings({ warmKiller: true });
    check('patchSettings({warmKiller:true}) 持久化', (await warmNow()) === true);
    // 確認沒有波及其他設定（tixuisid 仍在）
    check('切換保溫不會清掉其他設定', typeof (await settings.getSettings()).ticketQuantity === 'number');
    await settings.patchSettings({ warmKiller: false });
    check('patchSettings({warmKiller:false})', (await warmNow()) === false);

    console.log('\n【LINE/Telegram 指令 /set 保溫】');
    let r = await processCommand('/set 保溫 on');
    check('/set 保溫 on 回應正確', /已開啟.*保溫/.test(r), `(回應: ${r.slice(0, 20)}…)`);
    check('/set 保溫 on 真的寫入', (await warmNow()) === true);

    r = await processCommand('/set 保溫 off');
    check('/set 保溫 off 回應正確', /已關閉.*保溫/.test(r));
    check('/set 保溫 off 真的寫入', (await warmNow()) === false);

    r = await processCommand('/set warm on');
    check('/set warm on 別名可用', /已開啟.*保溫/.test(r) && (await warmNow()) === true);

    r = await processCommand('/set 保溫 maybe');
    check('/set 保溫 maybe → 提示 on/off', /請指定 on 或 off/.test(r));
    check('非法值不改動現值（仍為 true）', (await warmNow()) === true);

    r = await processCommand('/set help');
    check('/set help 含「保溫」說明', /保溫/.test(r));
  } finally {
    if (backup !== null) fs.writeFileSync(SETTINGS, backup, 'utf8');
    else if (fs.existsSync(SETTINGS)) fs.unlinkSync(SETTINGS);
    console.log('\n(已還原原本的 settings.json)');
  }

  console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
  process.exit(fail ? 1 : 0);
})();

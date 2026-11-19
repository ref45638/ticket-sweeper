/**
 * 驗證輪詢排程設定（拓元/遠大間隔、降頻時段與間隔）的預設值、驗證規則與降頻時段判定。
 * 會先備份 src/settings.json，跑完還原，不更動你的實際設定。
 * 不需瀏覽器。執行：node test/schedule-settings.test.js
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');
const settings = require('../src/config/settings');
const { isQuietHour } = require('../src/scheduler');

const SETTINGS = path.join(__dirname, '../src/settings.json');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
};

(async () => {
  const backup = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : null;
  try {
    console.log('【預設值】');
    fs.writeFileSync(SETTINGS, '{}\n', 'utf8');
    let s = await settings.getSettings();
    check('拓元間隔沿用 .env SCRAPE_INTERVAL_MS', s.scrapeIntervalMs === config.scrapeIntervalMs, `(${s.scrapeIntervalMs})`);
    check('遠大間隔預設 15 秒', s.ticketplusIntervalMs === 15_000);
    check('降頻時段預設 3~9 點、間隔 5 分鐘', s.quietStartHour === 3 && s.quietEndHour === 9 && s.quietIntervalMs === 300_000);

    console.log('\n【合法值持久化】');
    s = await settings.patchSettings({ scrapeIntervalMs: 45_000, ticketplusIntervalMs: 20_000, quietStartHour: 23, quietEndHour: 6, quietIntervalMs: 600_000 });
    const reread = await settings.getSettings();
    check('五個欄位都寫入', reread.scrapeIntervalMs === 45_000 && reread.ticketplusIntervalMs === 20_000 && reread.quietStartHour === 23 && reread.quietEndHour === 6 && reread.quietIntervalMs === 600_000);
    check('時段 0 點可存', (await settings.patchSettings({ quietStartHour: 0 })).quietStartHour === 0);

    console.log('\n【非法值】');
    s = await settings.patchSettings({ scrapeIntervalMs: 3000 });
    check('間隔低於 10 秒 → 拉到 10 秒', s.scrapeIntervalMs === 10_000);
    s = await settings.patchSettings({ ticketplusIntervalMs: null, quietIntervalMs: 'abc' });
    check('null / 非數字間隔 → 維持原值', s.ticketplusIntervalMs === 20_000 && s.quietIntervalMs === 600_000);
    s = await settings.patchSettings({ quietStartHour: 24, quietEndHour: -1 });
    check('時段超出 0~23 → 維持原值', s.quietStartHour === 0 && s.quietEndHour === 6);
    s = await settings.patchSettings({ quietEndHour: null });
    check('時段 null（UI 清空）→ 維持原值，不會變 0 點', s.quietEndHour === 6);
    s = await settings.patchSettings({ warmKiller: true });
    check('改其他設定不影響排程', s.scrapeIntervalMs === 10_000 && s.quietEndHour === 6);

    console.log('\n【降頻時段判定 isQuietHour】');
    const q = (start, end) => ({ quietStartHour: start, quietEndHour: end });
    check('3~9：3 點算、8 點算、9 點不算、2 點不算', isQuietHour(q(3, 9), 3) && isQuietHour(q(3, 9), 8) && !isQuietHour(q(3, 9), 9) && !isQuietHour(q(3, 9), 2));
    check('跨午夜 23~6：23、0、5 點算，6、12、22 點不算', isQuietHour(q(23, 6), 23) && isQuietHour(q(23, 6), 0) && isQuietHour(q(23, 6), 5) && !isQuietHour(q(23, 6), 6) && !isQuietHour(q(23, 6), 12) && !isQuietHour(q(23, 6), 22));
    check(
      '起訖相同 → 全天不降頻',
      [0, 5, 12, 23].every((h) => !isQuietHour(q(5, 5), h))
    );
  } finally {
    if (backup !== null) fs.writeFileSync(SETTINGS, backup, 'utf8');
    else if (fs.existsSync(SETTINGS)) fs.unlinkSync(SETTINGS);
    console.log('\n(已還原原本的 settings.json)');
  }

  console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
  process.exit(fail ? 1 : 0);
})();

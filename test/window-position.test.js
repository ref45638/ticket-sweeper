/**
 * 驗證視窗定位修法（需求②：Killer 固定顯示在視野內）。
 * 核心情境：profile 殘留「畫外座標」時，killer 的 --window-position=0,0 能不能把視窗拉回畫面內。
 *
 * 注意：此處的啟動參數刻意對齊 src/scrapers/browser.js 的 getBrowser()：
 *   - killer → --window-position=0,0
 *   - headful scout → --window-position=-2000,-2000
 * 用暫存 profile，不碰正式 scout/killer profile。執行：node test/window-position.test.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

async function launch(profile, positionArg) {
  const { browser } = await connect({
    headless: false,
    turnstile: true,
    fingerprint: true,
    customConfig: { userDataDir: profile },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768', positionArg],
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  });
  return browser;
}

async function windowLeft(browser) {
  const pages = await browser.pages();
  const session = await pages[0].target().createCDPSession();
  const { windowId } = await session.send('Browser.getWindowForTarget');
  const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
  await session.detach().catch(() => {});
  return bounds.left;
}

(async () => {
  const killerProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-win-killer-'));
  const scoutProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-win-scout-'));

  try {
    console.log('【情境：killer profile 先被卡在畫外，模擬殘留錯位】');
    let b = await launch(killerProfile, '--window-position=-2000,-2000');
    const strandedLeft = await windowLeft(b);
    console.log(`  先用 -2000 啟動一次（殘留畫外座標到 profile），left=${strandedLeft}`);
    await b.close().catch(() => {});

    console.log('\n【修法：同一個 profile 改用 killer 的 0,0 旗標重啟】');
    b = await launch(killerProfile, '--window-position=0,0');
    const killerLeft = await windowLeft(b);
    check('Killer 被拉回畫面內（left 約 0，不再卡在 -2000）', killerLeft > -200, `(left=${killerLeft})`);
    await b.close().catch(() => {});

    console.log('\n【對照：headful Scout 用 -2000 旗標應在畫外】');
    b = await launch(scoutProfile, '--window-position=-2000,-2000');
    const scoutLeft = await windowLeft(b);
    check('Scout 在畫面外（left 明顯為大負值）', scoutLeft < -500, `(left=${scoutLeft})`);
    await b.close().catch(() => {});
  } finally {
    fs.rmSync(killerProfile, { recursive: true, force: true });
    fs.rmSync(scoutProfile, { recursive: true, force: true });
  }

  console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('測試例外:', e);
  process.exit(2);
});

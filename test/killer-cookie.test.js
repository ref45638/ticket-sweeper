/**
 * 行為測試：Killer 的 TIXUISID 覆蓋 / 移除（injectCookie / removeLoginCookie）。
 *
 * 重現實況：killer 分頁剛開時是 about:blank，而 cookie jar 裡已有拓元發給匿名訪客的
 * host-only TIXUISID（保溫時匿名造訪拿到的）。驗證每次都能真正清掉舊的、只留下設定值那一顆。
 * 不連網，只操作暫存 profile 的 cookie jar；測試值皆為假值。
 *
 * 執行：node test/killer-cookie.test.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { injectCookie, removeLoginCookie } = require('../src/scrapers/tixcraft');

const AREA_URL = 'https://tixcraft.com/ticket/area/26_test/1';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ PASS  ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ❌ FAIL  ${name}${extra ? '  ' + extra : ''}`);
  }
}

(async () => {
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-test-'));
  console.log(`\n啟動測試瀏覽器（暫存 profile: ${tmpProfile}）…\n`);

  const { browser } = await connect({
    headless: false,
    turnstile: true,
    fingerprint: true,
    customConfig: { userDataDir: tmpProfile },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=-2000,-2000'],
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  });

  const page = await browser.newPage(); // 與 withPage 相同：新分頁停在 about:blank
  const tix = async () => (await page.cookies(AREA_URL)).filter((c) => c.name === 'TIXUISID');
  const fake = (name, value, extra) => ({ name, value, path: '/', httpOnly: true, secure: true, ...extra });

  try {
    // 保溫後的狀態：伺服器發的匿名 host-only TIXUISID + 舊版注入留下的 .tixcraft.com TIXUISID + cf_clearance
    await page.setCookie(fake('TIXUISID', 'anon-from-server', { url: 'https://tixcraft.com' }), fake('TIXUISID', 'legacy-domain-cookie', { domain: '.tixcraft.com' }), fake('cf_clearance', 'cf-test', { domain: '.tixcraft.com' }));

    console.log('【舊做法對照（資訊性）】');
    const oldSeen = (await page.cookies(page.url())).filter((c) => c.name === 'TIXUISID').length;
    console.log(`  → 在 ${page.url()} 用 page.cookies(page.url()) 只看得到 ${oldSeen} 顆 TIXUISID（實際有 ${(await tix()).length} 顆），所以舊版刪不掉`);

    console.log('\n【injectCookie：從 about:blank 強制覆蓋】');
    await injectCookie(page, 'mine-from-settings', AREA_URL);
    let t = await tix();
    check('只剩一顆 TIXUISID', t.length === 1, JSON.stringify(t.map((c) => [c.domain, c.value])));
    check('值是設定值', t[0]?.value === 'mine-from-settings');
    check('是 host-only（domain 無前導點）', t[0]?.domain === 'tixcraft.com', t[0]?.domain);

    console.log('\n【伺服器之後 Set-Cookie 換值 → 直接覆蓋，不長雙胞胎】');
    await page.setCookie(fake('TIXUISID', 'rotated-by-server', { url: 'https://tixcraft.com' }));
    t = await tix();
    check('仍只有一顆且為新值', t.length === 1 && t[0].value === 'rotated-by-server', JSON.stringify(t.map((c) => [c.domain, c.value])));

    console.log('\n【removeLoginCookie：從 about:blank 指定網址回匿名】');
    await removeLoginCookie(page, AREA_URL);
    check('TIXUISID 全清', (await tix()).length === 0);
    check(
      'cf_clearance 保留（維持 CF 暖狀態）',
      (await page.cookies(AREA_URL)).some((c) => c.name === 'cf_clearance')
    );
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }

  console.log(`\n===== 結果：${pass} 通過 / ${fail} 失敗 =====\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('測試執行發生例外:', e);
  process.exit(2);
});

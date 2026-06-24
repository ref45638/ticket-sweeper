/**
 * 行為測試：在「真實 Chromium DOM」中驗證兩項高優先修正
 *   #1 detectBlockPage —— WAF / Cloudflare 阻擋頁偵測
 *   #2 CAPTCHA_*_SELECTOR —— 統一後的驗證碼選擇器
 *
 * 用 puppeteer-real-browser（與 bot 同一套引擎）開一個「獨立的暫存 profile」，
 * 不碰使用者正在跑的 scout/killer profile，因此不會干擾 :3000 的長駐實例。
 *
 * 執行：node test/scraper-logic.test.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');

const {
  parseAreaList,
  detectBlockPage,
  CAPTCHA_IMG_SELECTOR,
  CAPTCHA_INPUT_SELECTOR,
} = require('../src/scrapers/tixcraft');

// ---- 測試素材（fixtures）----

const FIX_CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-running"></div><div class="cf-turnstile"></div>
<p>Verifying you are human. This may take a few seconds.</p></body></html>`;

const FIX_INTERSTITIAL = `<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Checking your browser before accessing the site.</h1></body></html>`;

const FIX_SOLDOUT = `<!doctype html><html><head><title>拓元售票</title></head><body>
<ul class="area-list">
  <li class="select_form_a"><a id="a1">A 區 2680 <font color="#AAAAAA">已售完 Sold out</font></a></li>
</ul></body></html>`;

const FIX_AVAILABLE = `<!doctype html><html><head><title>拓元售票</title></head><body>
<ul class="area-list">
  <li class="select_form_1"><a id="z1" href="/ticket/ticket/x">B 區 3880 <font color="#FF0000">熱賣中</font></a></li>
  <li class="select_form_2"><a id="z2" href="/ticket/ticket/y">C 區 2680 剩餘 5</a></li>
  <li class="select_form_3"><a id="z3" href="/ticket/ticket/z">輪椅席 <font color="#FF0000">熱賣中</font></a></li>
  <li class="select_form_4"><a id="z4">D 區 已售完</a></li>
</ul></body></html>`;

// 驗證碼表單：真實 id
const FIX_CAPTCHA_REAL = `<!doctype html><html><body>
<img id="TicketForm_verifyCode-image" src="/ticket/captcha?u=0.5" />
<input id="TicketForm_verifyCode" name="TicketForm[verifyCode]" />
</body></html>`;

// 驗證碼表單：舊 id（imageRandom），且故意拿掉 src 以確保是靠 id 命中而非 fallback
const FIX_CAPTCHA_LEGACY = `<!doctype html><html><body>
<img id="TicketForm_imageRandom" />
<input id="TicketForm_verifyCode" name="TicketForm[verifyCode]" />
</body></html>`;

// ---- 簡易斷言工具 ----
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

  const page = await browser.newPage();

  try {
    // === #1 detectBlockPage ===
    console.log('【#1 WAF 阻擋頁偵測】');
    await page.setContent(FIX_CHALLENGE);
    check('Cloudflare 挑戰頁 → 判定為阻擋', (await page.evaluate(detectBlockPage)) === 'cloudflare-challenge');

    await page.setContent(FIX_INTERSTITIAL);
    check('Cloudflare 攔截文字頁 → 判定為阻擋', (await page.evaluate(detectBlockPage)) === 'cloudflare-interstitial');

    await page.setContent(FIX_SOLDOUT);
    check('正常售完頁 → 不誤判為阻擋', (await page.evaluate(detectBlockPage)) === null);

    await page.setContent(FIX_AVAILABLE);
    check('正常有票頁 → 不誤判為阻擋', (await page.evaluate(detectBlockPage)) === null);

    // === #1b parseAreaList 分類仍正確 ===
    console.log('\n【區域解析分類】');
    const sold = await page.setContent(FIX_SOLDOUT).then(() => page.evaluate(parseAreaList));
    check('售完頁：所有區域 soldOut', sold.sections.length === 1 && sold.sections.every((s) => s.soldOut), `(共 ${sold.sections.length} 區)`);

    const avail = await page.setContent(FIX_AVAILABLE).then(() => page.evaluate(parseAreaList, { markRandomAvailable: true }));
    const availNames = avail.sections.filter((s) => s.available).map((s) => s.name);
    // 註：name 會保留票價（如「B 區 3880」），故用 startsWith 比對。
    check('有票頁：B/C 區判為可購', availNames.some((n) => n.startsWith('B 區')) && availNames.some((n) => n.startsWith('C 區')), `(available=${JSON.stringify(availNames)})`);
    check('有票頁：D 區（已售完）判為售完', avail.sections.find((s) => s.name.startsWith('D 區'))?.soldOut === true);
    check('有票頁：隨機標記一個可購區並回傳 chosen', !!avail.chosen && availNames.includes(avail.chosen.name), `(chosen=${avail.chosen?.name})`);
    // 輪椅席雖在 parse 階段 available=true，但不會被放進 candidates，故 chosen 不該是輪椅席
    // （最終由 Node 端 classifySection 把輪椅/身障改判為 ignored）
    check('有票頁：輪椅席不被選為 chosen 目標', !String(avail.chosen?.name).includes('輪椅'));

    // === #2 統一後的驗證碼選擇器 ===
    console.log('\n【#2 驗證碼選擇器統一】');
    console.log(`  IMG  = ${CAPTCHA_IMG_SELECTOR}`);
    console.log(`  INPUT= ${CAPTCHA_INPUT_SELECTOR}`);

    await page.setContent(FIX_CAPTCHA_REAL);
    check('真實 id：IMG 選擇器命中驗證碼圖', await page.evaluate((s) => !!document.querySelector(s), CAPTCHA_IMG_SELECTOR));
    check('真實 id：命中的就是 verifyCode-image', await page.evaluate((s) => document.querySelector(s)?.id, CAPTCHA_IMG_SELECTOR).then((id) => id === 'TicketForm_verifyCode-image'), '');
    check('真實 id：INPUT 選擇器命中輸入框', await page.evaluate((s) => !!document.querySelector(s), CAPTCHA_INPUT_SELECTOR));

    await page.setContent(FIX_CAPTCHA_LEGACY);
    check('舊 id：IMG 選擇器仍能命中（imageRandom，無 src）', await page.evaluate((s) => !!document.querySelector(s), CAPTCHA_IMG_SELECTOR));

    // === 對「真實 tixcraft」做一次驗證（資訊性，不計入成敗，因為線上狀態會變）===
    console.log('\n【真實 tixcraft 連線驗證（資訊性）】');
    const realUrl = 'https://tixcraft.com/ticket/area/26_kyuhyun/22386';
    try {
      await page.goto(realUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('ul.area-list li, .area-list li, ul li', { timeout: 12000 }).catch(() => {});
      const realBlock = await page.evaluate(detectBlockPage);
      const realParse = await page.evaluate(parseAreaList);
      console.log(`  → URL: ${realUrl}`);
      console.log(`  → 目前頁面網址: ${page.url()}`);
      console.log(`  → detectBlockPage 判定: ${realBlock === null ? '未阻擋 (正常通過)' : realBlock}`);
      console.log(`  → 解析到 ${realParse.sections.length} 個區域（可購 ${realParse.sections.filter((s) => s.available).length}）`);
      if (realParse.sections.length) {
        console.log('  → 前幾區:', realParse.sections.slice(0, 4).map((s) => `${s.name}[${s.soldOut ? '售完' : '可購'}]`).join(', '));
      }
    } catch (e) {
      console.log(`  → 真實連線略過（不影響上面測試結論）: ${e.message}`);
    }
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

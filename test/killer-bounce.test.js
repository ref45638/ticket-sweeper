/**
 * 行為測試：Killer 點區後被拓元彈回 /activity/game 的處理（enterTicketPage / clickSubmit）。
 *
 * 用本機 HTTP 假站重現實測行為：點到剛售完的區 → alert「此場次/區域已售完」+ 302 到 /activity/game。
 * 用 puppeteer-real-browser 開「獨立暫存 profile」，不碰 :3000 長駐實例的 scout/killer profile。
 *
 * 執行：node test/killer-bounce.test.js
 */
const http = require('http');
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { enterTicketPage, clickSubmit } = require('../src/scrapers/tixcraft');

const AREA_PATH = '/ticket/area/26_test/1';
const GAME_PATH = '/activity/game/26_test';

// ---- 假站 ----
// bounceTimes：前幾次進 /ticket/ticket 要被彈回；soldOutArea：區域頁全部售完
const server = {
  bounceTimes: 0,
  soldOutArea: false,
  hits: { area: 0, ticket: 0, game: 0 },
  reset(opts) {
    Object.assign(this, { bounceTimes: 0, soldOutArea: false }, opts);
    this.hits = { area: 0, ticket: 0, game: 0 };
  },
};

const AREA_HTML = (soldOut) => `<!doctype html><html><body>
<ul class="area-list">
  ${
    soldOut
      ? '<li class="select_form_a"><a id="a1">黃3A區1800 <font color="#AAAAAA">已售完</font></a></li>'
      : `<li class="select_form_1"><a id="z1" href="/ticket/ticket/26_test/1/1/1">黃3B區1800 剩餘 2</a></li>
         <li class="select_form_2"><a id="z2" href="/ticket/ticket/26_test/1/2/2">黃3E區1800 <font color="#FF0000">熱賣中</font></a></li>`
  }
</ul></body></html>`;

// 拓元 game 頁有「立即訂購」(.btn-primary)，舊 clickSubmit 會誤點它回到區域頁
const GAME_HTML = `<!doctype html><html><body>
<script>alert('此場次/區域已售完')</script>
<table><tr><td>2026/11/29</td><td><button class="btn btn-primary" onclick="location.href='${AREA_PATH}'">立即訂購</button></td></tr></table>
</body></html>`;

const TICKET_HTML = `<!doctype html><html><body>
<form><select id="TicketForm_ticketPrice"><option value="0">0</option><option value="2">2</option></select>
<input type="checkbox" id="TicketForm_agree"><button type="submit">確認張數</button></form>
</body></html>`;

const httpServer = http.createServer((req, res) => {
  const url = req.url;
  if (url.startsWith('/ticket/area/')) {
    server.hits.area++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(AREA_HTML(server.soldOutArea));
  }
  if (url.startsWith('/ticket/ticket/')) {
    server.hits.ticket++;
    if (server.hits.ticket <= server.bounceTimes) {
      res.writeHead(302, { Location: GAME_PATH });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TICKET_HTML);
  }
  if (url.startsWith('/activity/game/')) {
    server.hits.game++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(GAME_HTML);
  }
  res.writeHead(404);
  res.end();
});

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
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const areaUrl = base + AREA_PATH;

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
  // 與 attemptAddToCart 相同：自動接受 alert，否則 game 頁的 alert 會卡住載入
  page.on('dialog', (d) => d.accept().catch(() => {}));

  const startAtArea = async (opts) => {
    server.reset(opts);
    await page.goto(areaUrl, { waitUntil: 'domcontentloaded' });
  };

  try {
    console.log('【點區直接進填單頁】');
    await startAtArea({ bounceTimes: 0 });
    let r = await enterTicketPage(page, areaUrl);
    check('回傳 chosen、無 error', !!r.chosen && !r.error, JSON.stringify(r));
    check('停在 /ticket/ticket 填單頁', page.url().includes('/ticket/ticket/'), page.url());

    console.log('\n【第一次被彈回 game 頁 → 改選別區】');
    await startAtArea({ bounceTimes: 1 });
    r = await enterTicketPage(page, areaUrl);
    check('最終進到填單頁', !!r.chosen && page.url().includes('/ticket/ticket/'), `${JSON.stringify(r)} @ ${page.url()}`);
    check('重新進區域頁一次（area 共 2 次）', server.hits.area === 2, JSON.stringify(server.hits));

    console.log('\n【每次都被彈回 → 用完次數放棄】');
    await startAtArea({ bounceTimes: 99 });
    r = await enterTicketPage(page, areaUrl);
    check("回傳 error='bounced'", r.error === 'bounced', JSON.stringify(r));
    check('點區 3 次後停手', server.hits.ticket === 3, JSON.stringify(server.hits));

    console.log('\n【區域頁全部售完】');
    await startAtArea({ soldOutArea: true });
    r = await enterTicketPage(page, areaUrl);
    check("回傳 error='soldout'", r.error === 'soldout', JSON.stringify(r));

    console.log('\n【clickSubmit 不在外層頁亂按】');
    server.reset();
    await page.goto(base + GAME_PATH, { waitUntil: 'domcontentloaded' });
    const clicked = await clickSubmit(page);
    await new Promise((res) => setTimeout(res, 500));
    check('game 頁上 clickSubmit 回傳 false', clicked === false);
    check('沒有誤點「立即訂購」跳回區域頁', server.hits.area === 0 && page.url().includes(GAME_PATH), page.url());

    server.reset();
    await page.goto(base + '/ticket/ticket/26_test/1/1/1', { waitUntil: 'domcontentloaded' });
    check('填單頁上 clickSubmit 照常按下', (await clickSubmit(page)) === true);
  } finally {
    await browser.close().catch(() => {});
    httpServer.close();
    fs.rmSync(tmpProfile, { recursive: true, force: true });
  }

  console.log(`\n===== 結果：${pass} 通過 / ${fail} 失敗 =====\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('測試執行發生例外:', e);
  process.exit(2);
});

/**
 * 解析 parity 對拍：同一份 HTML 分別餵給「DOM 版 parseAreaList（真實 Chromium）」與
 * 「cheerio 版 parseAreaHtml（Node）」，逐欄位比對，證明免渲染移植與現行渲染版等價。
 * 用獨立暫存 profile，不碰 :3000 長駐實例；只用 page.setContent（不連網）。
 *
 * 執行：node test/parse-parity.test.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseAreaList, parseAreaHtml } = require('../src/scrapers/tixcraft');

const BASE_URL = 'https://teamear.tixcraft.com/ticket/area/26_demo/12345';

const FIXTURES = {
  售完頁: `<!doctype html><html><body><ul class="area-list">
    <li class="select_form_a"><a id="a1">A 區 2680 <font color="#AAAAAA">已售完 Sold out</font></a></li>
  </ul></body></html>`,
  有票頁: `<!doctype html><html><body><ul class="area-list">
    <li class="select_form_1"><a id="z1" href="/ticket/ticket/x">B 區 3880 <font color="#FF0000">熱賣中</font></a></li>
    <li class="select_form_2"><a id="z2" href="/ticket/ticket/y">C 區 2680 剩餘 5</a></li>
    <li class="select_form_3"><a id="z3" href="/ticket/ticket/z">輪椅席 <font color="#FF0000">熱賣中</font></a></li>
    <li class="select_form_4"><a id="z4">D 區 已售完</a></li>
  </ul></body></html>`,
  英文剩餘: `<!doctype html><html><body><ul class="area-list">
    <li class="select_form_5"><a id="e1" href="/t/e">Section E 3 seat(s) remaining</a></li>
    <li class="select_form_6"><a id="e2" href="/t/f">Section F <font color="#AAAAAA">Sold out</font></a></li>
  </ul></body></html>`,
};

// href 在 DOM（about:blank base）與 cheerio（baseUrl）語意不同，故不納入 parity 比對；其餘欄位須完全一致。
const FIELDS = ['id', 'name', 'remaining', 'hotSelling', 'available', 'soldOut', 'clickable'];
const norm = (s) => FIELDS.map((f) => `${f}=${JSON.stringify(s[f])}`).join(' | ');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-parity-'));
  console.log(`\n啟動 parity 瀏覽器（暫存 profile: ${tmp}）…\n`);
  const { browser } = await connect({
    headless: false,
    turnstile: true,
    fingerprint: true,
    customConfig: { userDataDir: tmp },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=-2000,-2000'],
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  });
  const page = await browser.newPage();

  let pass = 0;
  let fail = 0;
  try {
    for (const [label, html] of Object.entries(FIXTURES)) {
      await page.setContent(html);
      const dom = (await page.evaluate(parseAreaList)).sections.map(norm);
      const che = parseAreaHtml(html, BASE_URL).sections.map(norm);
      const ok = dom.length === che.length && JSON.stringify(dom) === JSON.stringify(che);
      if (ok) {
        pass++;
        console.log(`  ✅ ${label}: DOM ≡ cheerio（${dom.length} 區完全一致）`);
      } else {
        fail++;
        console.log(`  ❌ ${label}: 不一致`);
        console.log(`     DOM    : ${JSON.stringify(dom)}`);
        console.log(`     cheerio: ${JSON.stringify(che)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n===== parity 結果：${pass} 通過 / ${fail} 失敗 =====\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('parity 例外:', e);
  process.exit(2);
});

/**
 * 免渲染解析單元測試（browserless，不開瀏覽器、不連網）。
 * 驗證 cheerio 版 parseAreaHtml 的分類與 href 絕對化，以及 htmlLooksBlocked 的挑戰頁偵測，
 * 判斷規則需與現行 DOM 版 parseAreaList / detectBlockPage 一致（直接對拍見 parse-parity.test.js）。
 *
 * 執行：node test/parse-area-html.test.js
 */
const { parseAreaHtml, htmlLooksBlocked } = require('../src/scrapers/tixcraft');

// ---- 測試素材（與 scraper-logic.test.js 同款，確保兩測涵蓋一致）----

const FIX_CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="challenge-running"></div><div class="cf-turnstile"></div>
<p>Verifying you are human. This may take a few seconds.</p></body></html>`;

const FIX_INTERSTITIAL = `<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head>
<body><h1>Checking your browser before accessing the site.</h1></body></html>`;

const FIX_ACCESS_DENIED = `<!doctype html><html><head><title>Access denied</title></head>
<body><h1>Error 1020</h1><p>Access denied</p></body></html>`;

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

// 子網域 baseUrl，用來驗證相對 href 會被轉成絕對（cheerio attr('href') 是原始屬性值）
const BASE_URL = 'https://teamear.tixcraft.com/ticket/area/26_demo/12345';

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

// === #1 parseAreaHtml 分類 ===
console.log('\n【parseAreaHtml 區域解析分類（cheerio）】');

const sold = parseAreaHtml(FIX_SOLDOUT, BASE_URL);
check('售完頁：解析出 1 區', sold.sections.length === 1, `(共 ${sold.sections.length} 區)`);
check('售完頁：該區 soldOut 且非可購', sold.sections[0]?.soldOut === true && sold.sections[0]?.available === false);
check('售完頁：名稱保留票價、去除售完字樣', sold.sections[0]?.name === 'A 區 2680', `(name=${JSON.stringify(sold.sections[0]?.name)})`);

const avail = parseAreaHtml(FIX_AVAILABLE, BASE_URL);
const availNames = avail.sections.filter((s) => s.available).map((s) => s.name);
check('有票頁：解析出 4 區', avail.sections.length === 4, `(共 ${avail.sections.length} 區)`);
check('有票頁：B/C 區判為可購', availNames.some((n) => n.startsWith('B 區')) && availNames.some((n) => n.startsWith('C 區')), `(available=${JSON.stringify(availNames)})`);
check('有票頁：D 區（已售完）判為售完', avail.sections.find((s) => s.name.startsWith('D 區'))?.soldOut === true);
check('有票頁：C 區抓到剩餘 5', avail.sections.find((s) => s.name.startsWith('C 區'))?.remaining === 5);
check('有票頁：B 區 hotSelling=true', avail.sections.find((s) => s.name.startsWith('B 區'))?.hotSelling === true);
// 輪椅席在 parse 階段 available=true（與 DOM 版一致），最終由 Node 端 classifySection 改判 ignored
check('有票頁：輪椅席在 parse 階段 available=true（分類交給 classifySection）', avail.sections.find((s) => s.name.includes('輪椅'))?.available === true);

// === #2 href 絕對化（cheerio 特有：需 new URL(raw, baseUrl)）===
console.log('\n【href 絕對化】');
const bHref = avail.sections.find((s) => s.name.startsWith('B 區'))?.href;
check('相對 href 轉為絕對（帶子網域 origin）', bHref === 'https://teamear.tixcraft.com/ticket/ticket/x', `(href=${bHref})`);
check('D 區無 href → null', avail.sections.find((s) => s.name.startsWith('D 區'))?.href === null);

// === #3 htmlLooksBlocked 挑戰頁偵測 ===
console.log('\n【htmlLooksBlocked 挑戰頁偵測】');
check('Cloudflare 挑戰頁 → cloudflare-challenge', htmlLooksBlocked(FIX_CHALLENGE) === 'cloudflare-challenge', `(${htmlLooksBlocked(FIX_CHALLENGE)})`);
check('Cloudflare 攔截文字頁 → cloudflare-interstitial', htmlLooksBlocked(FIX_INTERSTITIAL) === 'cloudflare-interstitial', `(${htmlLooksBlocked(FIX_INTERSTITIAL)})`);
check('Access denied / 1020 → access-denied', htmlLooksBlocked(FIX_ACCESS_DENIED) === 'access-denied', `(${htmlLooksBlocked(FIX_ACCESS_DENIED)})`);
check('正常售完頁 → 不誤判為阻擋', htmlLooksBlocked(FIX_SOLDOUT) === null);
check('正常有票頁 → 不誤判為阻擋', htmlLooksBlocked(FIX_AVAILABLE) === null);
check('空字串 → null（空 body 由呼叫端 !html 判斷退場）', htmlLooksBlocked('') === null);

console.log(`\n===== 結果：${pass} 通過 / ${fail} 失敗 =====\n`);
process.exit(fail ? 1 : 0);

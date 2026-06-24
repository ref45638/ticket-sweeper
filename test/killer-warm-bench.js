/**
 * 量化「冷 Killer」的代價：證明保活（keep-alive）能省多少。
 * 測三段：
 *   1) connect() 瀏覽器 process 冷啟動耗時  ← 保活可完全省掉
 *   2) 第一次導航（冷 profile，過 CF）
 *   3) 同瀏覽器第二次導航（暖，process 與 CF 都已就緒）  ← 保活後每次都是這個
 * 用獨立暫存 profile，不碰 :3000 / killer 實例。執行：node test/killer-warm-bench.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { gotoAreaPage, parseAreaList } = require('../src/scrapers/tixcraft');

const URL = 'https://tixcraft.com/ticket/area/26_kyuhyun/22386';

async function navOnce(browser) {
  const page = await browser.newPage();
  const t0 = Date.now();
  const ready = await gotoAreaPage(page, URL);
  const sections = ready ? (await page.evaluate(parseAreaList)).sections.length : 0;
  const ms = Date.now() - t0;
  await page.close().catch(() => {});
  return { ms, ready, sections };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-killer-'));

  // 1) 量 connect() 冷啟動
  const tLaunch0 = Date.now();
  const { browser } = await connect({
    headless: false,
    turnstile: true,
    fingerprint: true,
    customConfig: { userDataDir: tmp },
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // killer 維持可見（與生產一致）
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  });
  const launchMs = Date.now() - tLaunch0;

  // 2) 冷導航
  const cold = await navOnce(browser);
  // 3) 暖導航（同一個瀏覽器，process+CF 已就緒）
  const warm1 = await navOnce(browser);
  const warm2 = await navOnce(browser);

  await browser.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });

  const warmAvg = Math.round((warm1.ms + warm2.ms) / 2);
  const coldTotal = launchMs + cold.ms; // 現況：每次搶票要付的
  const warmTotal = warmAvg; // 保活後：每次搶票要付的

  console.log('\n========== 冷 Killer vs 暖 Killer ==========');
  console.log(`  瀏覽器 process 冷啟動 connect(): ${launchMs} ms`);
  console.log(`  第一次導航(冷 profile/過 CF)   : ${cold.ms} ms  (區域 ${cold.sections})`);
  console.log(`  之後導航(暖, 平均)             : ${warmAvg} ms  (區域 ${warm1.sections}/${warm2.sections})`);
  console.log('  ------------------------------------------');
  console.log(`  現況每次搶票冷成本 = 啟動 + 冷導航 = ${coldTotal} ms`);
  console.log(`  保活後每次搶票成本 = 暖導航       = ${warmTotal} ms`);
  console.log(`  → 保活可省下約 ${coldTotal - warmTotal} ms（搶票起手少等這麼多）`);
  console.log('============================================\n');
})().catch((e) => {
  console.error('bench 例外:', e);
  process.exit(2);
});

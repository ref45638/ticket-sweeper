/**
 * #4 對照實測：Scout 導航策略
 *   - Part A 暖態：純 networkidle2 vs 純 domcontentloaded 的速度差
 *   - Part B 冷態：直接呼叫「生產用的 gotoAreaPage()」（domcontentloaded 快路徑 + networkidle2 退路）
 *     確認全新 profile 第一輪也能拿到區域列表
 * 用獨立暫存 profile，不碰 :3000 實例。執行：node test/scout-nav-bench.js
 */
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { parseAreaList, gotoAreaPage } = require('../src/scrapers/tixcraft');

const URL = 'https://tixcraft.com/ticket/area/26_kyuhyun/22386';
const AREA_SEL = 'ul.area-list li, .area-list li, ul li';

function launch(tmp) {
  return connect({
    headless: false,
    turnstile: true,
    fingerprint: true,
    customConfig: { userDataDir: tmp },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=-2000,-2000'],
    connectOption: { defaultViewport: null },
    disableXvfb: false,
  });
}

// 單一 waitUntil 策略的純導航量測（給 Part A 速度對照用）
async function measureRaw(page, waitUntil, gotoTimeout) {
  const t0 = Date.now();
  let ok = true;
  let sections = 0;
  try {
    await page.goto(URL, { waitUntil, timeout: gotoTimeout });
    await page.waitForSelector(AREA_SEL, { timeout: 25000 });
    sections = (await page.evaluate(parseAreaList)).sections.length;
  } catch (e) {
    ok = false;
  }
  return { ms: Date.now() - t0, ok, sections, waitUntil };
}

// 呼叫生產用的 gotoAreaPage（混合策略），量測整體耗時（給 Part B 冷態韌性用）
async function measureProd(page) {
  const t0 = Date.now();
  const ready = await gotoAreaPage(page, URL);
  let sections = 0;
  if (ready) sections = (await page.evaluate(parseAreaList)).sections.length;
  return { ms: Date.now() - t0, ok: ready, sections };
}

(async () => {
  // ===== Part A：暖態速度對照 =====
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-bench-'));
  console.log('啟動 bench 瀏覽器（Part A 暖態對照）…\n');
  const { browser } = await launch(tmpA);

  console.log('  暖身載入（建立 Cloudflare 通行 cookie）…');
  const warm = await browser.newPage();
  await measureProd(warm); // 用混合策略確保暖身一定成功
  await warm.close().catch(() => {});

  const plan = [
    ['domcontentloaded', 20000],
    ['networkidle2', 45000],
    ['domcontentloaded', 20000],
    ['networkidle2', 45000],
  ];
  const results = [];
  for (const [waitUntil, to] of plan) {
    const page = await browser.newPage();
    const r = await measureRaw(page, waitUntil, to);
    await page.close().catch(() => {});
    console.log(`  ${waitUntil.padEnd(16)} → ${String(r.ms).padStart(6)}ms | ${r.ok ? '成功' : '失敗'} | 區域 ${r.sections}`);
    results.push(r);
  }
  const avg = (w) => {
    const xs = results.filter((r) => r.waitUntil === w && r.ok).map((r) => r.ms);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  const dom = avg('domcontentloaded');
  const net = avg('networkidle2');
  const same = new Set(results.filter((r) => r.ok).map((r) => r.sections));
  console.log('\n--- Part A 暖態平均 ---');
  console.log(`  domcontentloaded(新): ${dom}ms`);
  console.log(`  networkidle2(舊)    : ${net}ms`);
  if (dom != null && net != null) console.log(`  → 新策略快約 ${net - dom}ms（${Math.round((1 - dom / net) * 100)}%）`);
  console.log(`  區域數一致性: ${same.size === 1 ? '✅ 一致 (' + [...same][0] + ' 區)' : '⚠️ 不一致 ' + [...same]}`);
  await browser.close().catch(() => {});
  fs.rmSync(tmpA, { recursive: true, force: true });

  // ===== Part B：冷態韌性（全新 profile，呼叫生產用 gotoAreaPage）=====
  console.log('\n啟動 bench 瀏覽器（Part B 冷態，全新 profile，跑生產用 gotoAreaPage）…');
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-bench-cold-'));
  const { browser: b2 } = await launch(tmpB);
  const cp = await b2.newPage();
  const cold = await measureProd(cp);
  console.log(`  冷載入 gotoAreaPage() → ${cold.ms}ms | ${cold.ok ? '✅ 成功' : '❌ 失敗'} | 區域 ${cold.sections}`);
  await b2.close().catch(() => {});
  fs.rmSync(tmpB, { recursive: true, force: true });

  console.log(`\n結論：暖態提速 ${dom != null && net != null ? Math.round((1 - dom / net) * 100) + '%' : 'N/A'}，冷態韌性 ${cold.ok ? 'OK' : '需再看'}`);
  process.exit(cold.ok ? 0 : 1);
})().catch((e) => {
  console.error('bench 例外:', e);
  process.exit(2);
});

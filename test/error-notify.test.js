/**
 * 驗證「同一站連續失敗 3 次才推播錯誤」與遠大逾時訊息帶 API 路徑。
 * 用 require cache 換掉 scrapers / notifier / sites / settings，不碰 settings.json、不打外部 API、不需瀏覽器。
 * 執行：node test/error-notify.test.js
 */
const path = require('path');

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

const mock = (rel, exports) => {
  const p = require.resolve(path.join(__dirname, '../src', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

let nextScrapeFails = false;
const sent = [];
mock('scrapers', {
  scrapeSite: async () => {
    if (nextScrapeFails) throw new Error('遠大 API 逾時 10 秒（/config/api/v1/get）');
    return { scrapedAt: new Date().toISOString(), sections: [], summary: { availableCount: 0, soldOutCount: 0, ignoredCount: 0 }, cartResult: null };
  },
  resolveScraper: () => ({ id: 'ticketplus' }),
  listScraperIds: () => [],
});
mock('notifier', { sendDirect: async (msg) => sent.push(msg), notifyForSiteResult: async () => [] });
mock('config/sites', {
  getSiteById: async (id) => ({ id, label: `測試站${id}`, url: 'https://ticketplus.com.tw/order/x/y', scraperId: 'ticketplus' }),
  listEnabledSites: async () => [],
});
mock('config/settings', { getSettings: async () => ({ notifyEvents: { scraperError: true } }) });

const scheduler = require('../src/scheduler');
const { scrapeTicketplus } = require('../src/scrapers/ticketplus');

const run = async (siteId, failIt) => {
  nextScrapeFails = failIt;
  await scheduler.scrapeSiteById(siteId);
};

(async () => {
  console.log('【連續失敗門檻】');
  await run('A', true);
  await run('A', true);
  check('連續失敗 2 次 → 不推播', sent.length === 0);
  await run('A', true);
  check('第 3 次 → 推播 1 則', sent.length === 1, `(${sent[0]?.split('\n')[0]})`);
  check('推播內容含錯誤訊息與 API 路徑', /\/config\/api\/v1\/get/.test(sent[0] || ''));
  await run('A', true);
  await run('A', true);
  check('第 4、5 次持續失敗 → 不重複推播', sent.length === 1);

  await run('A', false);
  await run('A', true);
  await run('A', true);
  check('成功一次後歸零，再失敗 2 次 → 不推播', sent.length === 1);
  await run('A', true);
  check('歸零後第 3 次 → 再推 1 則', sent.length === 2);

  await run('B', true);
  await run('A', false);
  await run('B', true);
  await run('B', true);
  check('各站分開計數（A 成功不影響 B）', sent.length === 3 && sent[2].includes('測試站B'));

  console.log('\n【遠大逾時訊息】');
  const realFetch = global.fetch;
  global.fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  try {
    await scrapeTicketplus('https://ticketplus.com.tw/order/75a694bf61cb28f0e24835916cfae36e/cc7bebaffee949042a01105dc2eb821c');
    check('逾時應拋錯', false);
  } catch (e) {
    check('逾時訊息帶 API 路徑', /逾時 10 秒（\/config\/api\/v1\/getS3）/.test(e.message), `(${e.message})`);
  } finally {
    global.fetch = realFetch;
  }

  console.log(`\n===== ${pass} 通過 / ${fail} 失敗 =====`);
  process.exit(fail ? 1 : 0);
})();

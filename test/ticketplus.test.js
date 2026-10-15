/**
 * 遠大（ticketplus）清票偵測測試。預設不連網：以假 fetch 回放官網 API 的回應結構，驗證有票判定、
 * 場次/隱藏過濾、分區與票種兩種模式、快取破壞參數、錯誤處理，以及爬蟲分派（網址優先）與拓元站點判斷。
 * 帶訂購頁網址參數時，另打一次真實 API 做 smoke（需連網）。
 *
 * 執行：node test/ticketplus.test.js
 *       node test/ticketplus.test.js https://ticketplus.com.tw/order/{活動}/{場次}
 */
const { scrapeTicketplus, matches } = require('../src/scrapers/ticketplus');
const { resolveScraper } = require('../src/scrapers');
const { isTixcraftSite } = require('../src/scrapers/tixcraft');

// ---- 測試素材（fixtures，欄位與 2026-10 實測的官網回應一致）----

const EVENT = '75a694bf61cb28f0e24835916cfae36e';
const SESSION = 'e5b0bd975472de317f809e51f64f0d4b';
const OTHER_SESSION = 'cc7bebaffee949042a01105dc2eb821c';
const ORDER_URL = `https://ticketplus.com.tw/order/${EVENT}/${SESSION}`;
const S3_MISSING = { errCode: '102', errMsg: 'Internal Server Error', errDetail: 'The specified key does not exist.' };

const area = (id, name, price, extra = {}) => ({ ticketAreaId: id, sessionId: SESSION, name, price, hidden: false, ...extra });
const AREAS = {
  ticketAreas: [
    area('a000000001', 'VIP A區6780', 6780), // onsale 5 → 剩 5（名稱已含票價，不重複補）
    area('a000000002', '紅2A區', 4880), // onsale 999999 → 熱賣中
    area('a000000003', '紅2B區', 4880), // onsale 但 count 0 → 售完
    area('a000000004', '黃3區', 3880), // soldout
    area('a000000005', '全區（不含身障區）', 2800), // pending → 售完；是一般區，不能被當身障略過
    area('a000000006', '紅2B輪椅身障區', 4880), // onsale 但身障 → 略過
    area('a000000007', '全區', 1499), // 同名不同價 → 補票價、各自判定
    area('a000000008', '全區', 749),
    area('a000000009', '綠5區', 1800), // 不限量 onsale → 熱賣中
    area('a000000010', '藍6區', 1000), // 即時 API 沒回 → 售完
    area('a000000011', '隱藏區', 100, { hidden: true }), // hidden → 排除
    area('a000000012', '他場VIP', 6780, { sessionId: OTHER_SESSION }), // 其他場次 → 排除
  ],
};
const LIVE_AREAS = {
  errCode: '00',
  result: {
    ticketArea: [
      { id: 'a000000001', status: 'onsale', count: 5, ticketAreaLimit: true },
      { id: 'a000000002', status: 'onsale', count: 999999, ticketAreaLimit: true },
      { id: 'a000000003', status: 'onsale', count: 0, ticketAreaLimit: true },
      { id: 'a000000004', status: 'soldout', ticketAreaLimit: true },
      { id: 'a000000005', status: 'pending', ticketAreaLimit: true },
      { id: 'a000000006', status: 'onsale', count: 2, ticketAreaLimit: true },
      { id: 'a000000007', status: 'onsale', count: 3, ticketAreaLimit: true },
      { id: 'a000000008', status: 'soldout', ticketAreaLimit: true },
      { id: 'a000000009', status: 'onsale', count: 0, ticketAreaLimit: false },
    ],
  },
};

const product = (id, name, price, extra = {}) => ({ productId: id, sessionId: SESSION, name, price, hidden: false, ...extra });
const PRODUCTS = {
  products: [
    product('p000000001', '全票', 1800), // onsale 2 → 剩 2
    product('p000000002', '身障票', 900), // onsale 但身障 → 略過
    product('p000000003', '預售票', 1500), // soldout
    product('p000000004', '全票', 1800, { sessionId: OTHER_SESSION }), // 其他場次 → 排除
  ],
};
const LIVE_PRODUCTS = {
  errCode: '00',
  result: {
    product: [
      { id: 'p000000001', status: 'onsale', count: 2, productLimit: true },
      { id: 'p000000002', status: 'onsale', count: 999999, productLimit: true },
      { id: 'p000000003', status: 'soldout', productLimit: true },
    ],
  },
};

// ---- 假 fetch：依網址回放 fixture，並記錄請求 ----
const realFetch = globalThis.fetch;
let requested = [];
function stubFetch({ ticketAreas = S3_MISSING, products = S3_MISSING, live, liveStatus = 200 }) {
  requested = [];
  globalThis.fetch = async (url) => {
    url = String(url);
    requested.push(url);
    let status = 200;
    let body;
    if (url.includes('/ticketAreas.json')) body = ticketAreas;
    else if (url.includes('/products.json')) body = products;
    else if (url.includes('/config/api/v1/get?')) [status, body] = [liveStatus, live];
    else throw new Error(`unexpected url: ${url}`);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

async function errorOf(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.message;
  }
}

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
  // === #1 分區模式：有票判定（對齊官網訂購頁）===
  console.log('\n【分區模式：有票判定】');
  stubFetch({ ticketAreas: AREAS, live: LIVE_AREAS });
  const r = await scrapeTicketplus(ORDER_URL);
  const byName = Object.fromEntries(r.sections.map((s) => [s.name, s]));
  const fmt = (s) => JSON.stringify(s && { status: s.status, remaining: s.remaining, hotSelling: s.hotSelling });

  check('只取本場次且未隱藏的 10 區', r.sections.length === 10, `(共 ${r.sections.length} 區)`);
  check('onsale + count 5 → 有票剩 5', byName['VIP A區6780']?.status === 'available' && byName['VIP A區6780'].remaining === 5, fmt(byName['VIP A區6780']));
  check('onsale + 999999 → 有票、熱賣中', byName['紅2A區 $4880']?.status === 'available' && byName['紅2A區 $4880'].remaining === null && byName['紅2A區 $4880'].hotSelling === true, fmt(byName['紅2A區 $4880']));
  check('onsale + count 0 → 售完', byName['紅2B區 $4880']?.status === 'soldOut', fmt(byName['紅2B區 $4880']));
  check('soldout → 售完', byName['黃3區 $3880']?.status === 'soldOut');
  check('pending → 售完，且「不含身障」一般區不被略過', byName['全區（不含身障區） $2800']?.status === 'soldOut', fmt(byName['全區（不含身障區） $2800']));
  check('輪椅身障區 → 略過', byName['紅2B輪椅身障區 $4880']?.status === 'ignored');
  check('同名不同價 → 補票價並各自判定', byName['全區 $1499']?.remaining === 3 && byName['全區 $749']?.status === 'soldOut');
  check('不限量 onsale → 有票、熱賣中', byName['綠5區 $1800']?.status === 'available' && byName['綠5區 $1800'].hotSelling === true, fmt(byName['綠5區 $1800']));
  check('即時 API 沒回的區 → 售完', byName['藍6區 $1000']?.status === 'soldOut');
  check('summary 計數正確', JSON.stringify(r.summary) === JSON.stringify({ availableCount: 4, soldOutCount: 5, ignoredCount: 1 }), JSON.stringify(r.summary));
  check('scraperId 為 ticketplus、不觸發加車', r.scraperId === 'ticketplus' && r.cartResult === null);

  const liveReq = requested.find((u) => u.includes('/config/api/v1/get?')) || '';
  const liveIds = new URL(liveReq).searchParams.get('ticketAreaId')?.split(',') || [];
  check('即時查詢帶 _=時間戳（破 CloudFront 快取）', /[?&]_=\d{13}$/.test(liveReq), liveReq.slice(-20));
  check('即時查詢只帶本場次未隱藏的區域', liveIds.length === 10 && !liveIds.includes('a000000011') && !liveIds.includes('a000000012'));
  check('分區模式不抓票種表', !requested.some((u) => u.includes('/products.json')));

  // === #2 票種模式：場次沒分區 ===
  console.log('\n【票種模式：場次沒分區】');
  stubFetch({ products: PRODUCTS, live: LIVE_PRODUCTS });
  const p = await scrapeTicketplus(ORDER_URL);
  const pByName = Object.fromEntries(p.sections.map((s) => [s.name, s]));
  check('只取本場次的 3 個票種', p.sections.length === 3, `(${p.sections.map((s) => s.name).join('、')})`);
  check('全票 onsale 2 → 有票剩 2', pByName['全票 $1800']?.status === 'available' && pByName['全票 $1800'].remaining === 2);
  check('身障票 → 略過', pByName['身障票 $900']?.status === 'ignored');
  check('soldout 票種 → 售完', pByName['預售票 $1500']?.status === 'soldOut');
  check('即時查詢改帶 productId', /[?&]productId=p000000001,p000000002,p000000003&_=/.test(requested.find((u) => u.includes('/get?')) || ''));

  // === #3 錯誤處理 ===
  console.log('\n【錯誤處理】');
  const notOrder = await errorOf(() => scrapeTicketplus(`https://ticketplus.com.tw/activity/${EVENT}`));
  check('非訂購頁網址 → 明確提示', /訂購頁網址/.test(notOrder || ''), `(${notOrder})`);
  stubFetch({ live: LIVE_AREAS });
  const noSession = await errorOf(() => scrapeTicketplus(ORDER_URL));
  check('找不到場次 → 拋錯', /找不到此場次/.test(noSession || ''), `(${noSession})`);
  stubFetch({ ticketAreas: AREAS, live: { errCode: '999', errMsg: 'boom' } });
  const badCode = await errorOf(() => scrapeTicketplus(ORDER_URL));
  check('即時 API errCode 非 00 → 拋錯', /errCode=999/.test(badCode || ''), `(${badCode})`);
  stubFetch({ ticketAreas: AREAS, live: {}, liveStatus: 403 });
  const http403 = await errorOf(() => scrapeTicketplus(ORDER_URL));
  check('HTTP 403 → 拋錯並帶狀態碼', /HTTP 403/.test(http403 || ''), `(${http403})`);

  // === #4 爬蟲分派與拓元站點判斷 ===
  console.log('\n【爬蟲分派（網址優先）與拓元站點判斷】');
  check('遠大網址即使存成 scraperId=tixcraft 也派給遠大', resolveScraper(ORDER_URL, 'tixcraft')?.id === 'ticketplus');
  check('拓元區域頁 → 拓元', resolveScraper('https://tixcraft.com/ticket/area/26_x/123', 'tixcraft')?.id === 'tixcraft');
  check('拓元活動頁（網址比對不到）→ 退回 scraperId', resolveScraper('https://tixcraft.com/activity/game/26_x', 'tixcraft')?.id === 'tixcraft');
  check('遠大非訂購頁也導給遠大爬蟲（由它給明確錯誤）', matches(`https://ticketplus.com.tw/activity/${EVENT}`));
  check('拓元主站與子網域算拓元站', isTixcraftSite({ url: 'https://tixcraft.com/ticket/area/x' }) && isTixcraftSite({ url: 'https://teamear.tixcraft.com/ticket/area/x' }));
  check('遠大不算拓元站（不參與 Scout/Killer 維護與 WAF 失憶）', !isTixcraftSite({ url: ORDER_URL }));

  // === #5 真實 API smoke（帶網址參數才跑）===
  const liveUrl = process.argv[2];
  if (liveUrl) {
    console.log('\n【真實 API smoke】');
    globalThis.fetch = realFetch;
    const t0 = Date.now();
    const real = await scrapeTicketplus(liveUrl);
    const ms = Date.now() - t0;
    const { availableCount, soldOutCount, ignoredCount } = real.summary;
    check('取得區域/票種', real.sections.length > 0, `(${real.sections.length} 筆，${ms}ms)`);
    check(
      'status 皆為三態之一',
      real.sections.every((s) => ['available', 'soldOut', 'ignored'].includes(s.status))
    );
    check('summary 加總等於筆數', availableCount + soldOutCount + ignoredCount === real.sections.length, JSON.stringify(real.summary));
    console.log(
      `  前 5 筆：${real.sections
        .slice(0, 5)
        .map((s) => `${s.name}=${s.status}${s.remaining ? `/${s.remaining}` : ''}`)
        .join('、')}`
    );
  }

  console.log(`\n===== 結果：${pass} 通過 / ${fail} 失敗 =====\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

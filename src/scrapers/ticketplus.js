/**
 * 遠大售票（ticketplus.com.tw）清票偵測：只做通知，不自動搶票。
 *
 * 訂購頁未登入會被前端導回活動頁，但頁面上的票況其實來自兩支公開 API（免登入、無 Cloudflare 挑戰），
 * 故純 Node fetch 即可，不需要瀏覽器：
 *   1. getS3 靜態 JSON：ticketAreas.json / products.json → 該場次的 ticketAreaId / productId 與名稱
 *   2. config/api/v1/get：即時 status + count（前面有 CloudFront 快取，必帶 _=時間戳）
 * 有票判定對齊官網訂購頁前端的顯示邏輯（見 toSection）。
 */
const API_BASE = 'https://apis.ticketplus.com.tw/config/api/v1';
const ORDER_URL_RE = /ticketplus\.com\.tw\/order\/([0-9a-f]{32})\/([0-9a-f]{32})/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
// 官網：count > 20 只顯示「熱賣中」不給張數（999999 即屬此類）
const HOT_THRESHOLD = 20;
// 身障相關區域/票種不通知；但「全區（不含身障區）」這類是一般區，不能誤殺
const IGNORE_RE = /輪椅|身障|身心|愛心/;

function matches(url) {
  return /ticketplus\.com\.tw/i.test(url);
}

function parseOrderUrl(url) {
  const m = ORDER_URL_RE.exec(url);
  if (!m) throw new Error('遠大請使用訂購頁網址：https://ticketplus.com.tw/order/{活動}/{場次}');
  return { eventHash: m[1].toLowerCase(), sessionHash: m[2].toLowerCase() };
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`遠大 API HTTP ${res.status}（${new URL(url).pathname}）`);
  return res.json();
}

/**
 * 單一區域/票種的即時票況 → section。判定對齊官網訂購頁：
 *   - onsale 且（不限量 或 count>0）才算有票；onsale 但 count=0 很常見（官網顯示「剩餘 0」）
 *   - soldout / unavailable / pending / over / lock 一律無票
 *   - 限量且 count≤20 才給確切張數，其餘（含 999999、不限量）視為熱賣中
 * @param {string} name 顯示名稱
 * @param {object|undefined} item config/api/v1/get 回傳的單筆（ticketArea 或 product）
 * @param {'ticketAreaLimit'|'productLimit'} limitKey
 */
function toSection(name, item, limitKey) {
  if (IGNORE_RE.test(name) && !name.includes('不含')) {
    return { name, status: 'ignored', remaining: 0 };
  }
  const { status, count } = item || {};
  const limited = Boolean(item?.[limitKey]);
  if (status !== 'onsale' || (limited && count != null && count <= 0)) {
    return { name, status: 'soldOut', remaining: 0 };
  }
  const exact = limited && count > 0 && count <= HOT_THRESHOLD;
  return { name, status: 'available', remaining: exact ? count : null, hotSelling: !limited || count > HOT_THRESHOLD };
}

/**
 * 場次目錄（已篩過場次）配上即時票況。有分區的場次以「區」為單位（與官網訂購頁一致），否則以「票種」為單位。
 * 同一場次可能有同名區域（同區不同票價），名稱未含票價時補上，避免通知冷卻鍵相撞。
 */
function buildSections(areas, products, result = {}) {
  const [items, liveList, idKey, limitKey] = areas.length ? [areas, result.ticketArea, 'ticketAreaId', 'ticketAreaLimit'] : [products, result.product, 'productId', 'productLimit'];
  const liveById = new Map((liveList || []).map((x) => [x.id, x]));
  return items.map((x) => {
    const name = x.name.includes(String(x.price)) ? x.name : `${x.name} $${x.price}`;
    return toSection(name, liveById.get(x[idKey]), limitKey);
  });
}

/**
 * @param {string} url 訂購頁網址 https://ticketplus.com.tw/order/{eventHash}/{sessionHash}
 */
async function scrapeTicketplus(url) {
  const { eventHash, sessionHash } = parseOrderUrl(url);
  const inSession = (x) => x.sessionId === sessionHash && !x.hidden;
  const s3 = (file) => getJson(`${API_BASE}/getS3?path=event/${eventHash}/${file}.json`);

  // 每輪重抓目錄：清票/加開可能新增區域，S3 JSON 走 CDN 成本低。沒分區的場次才需要票種表。
  const areas = ((await s3('ticketAreas')).ticketAreas || []).filter(inSession);
  const products = areas.length ? [] : ((await s3('products')).products || []).filter(inSession);
  if (!areas.length && !products.length) {
    throw new Error(`遠大找不到此場次的票區/票種（場次 ${sessionHash}），請確認訂購頁網址`);
  }

  const ids = areas.length ? `ticketAreaId=${areas.map((a) => a.ticketAreaId).join(',')}` : `productId=${products.map((p) => p.productId).join(',')}`;
  const live = await getJson(`${API_BASE}/get?${ids}&_=${Date.now()}`);
  if (live.errCode !== '00') {
    throw new Error(`遠大即時票況 API 錯誤 errCode=${live.errCode} ${live.errMsg || ''}`.trim());
  }

  const sections = buildSections(areas, products, live.result);
  const countOf = (status) => sections.filter((s) => s.status === status).length;
  return {
    scraperId: 'ticketplus',
    scrapedAt: new Date().toISOString(),
    sections,
    summary: { availableCount: countOf('available'), soldOutCount: countOf('soldOut'), ignoredCount: countOf('ignored') },
    cartResult: null, // 遠大只做通知，不自動搶票
  };
}

module.exports = { matches, scrapeTicketplus };

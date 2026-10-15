const tixcraft = require('./tixcraft');
const ticketplus = require('./ticketplus');

const scrapers = [
  {
    id: 'tixcraft',
    label: '拓元 / tixcraft',
    matches: tixcraft.matches,
    // 依 detectionMode 分派：fast(免渲染 fetch，預設) / render(舊渲染，退路)
    scrape: tixcraft.scrapeTixcraftAuto,
  },
  {
    id: 'ticketplus',
    label: '遠大 / ticketplus（僅通知）',
    matches: ticketplus.matches,
    scrape: ticketplus.scrapeTicketplus,
  },
];

function resolveScraper(url, scraperId) {
  // 網址比對優先：LINE/Telegram 的 /add 不帶 scraperId，createSite 會預設存成 'tixcraft'，
  // 若 scraperId 優先，遠大網址會被派給拓元爬蟲。比對不到（如拓元活動頁網址）才退回 scraperId。
  return scrapers.find((s) => s.matches(url)) ?? scrapers.find((s) => s.id === scraperId) ?? null;
}

function listScraperIds() {
  return scrapers.map((s) => ({ id: s.id, label: s.label }));
}

async function scrapeSite(site) {
  const scraper = resolveScraper(site.url, site.scraperId);
  if (!scraper) {
    throw new Error(`No scraper found for URL: ${site.url}`);
  }
  const result = await scraper.scrape(site.url, site);
  return result;
}

module.exports = { scrapeSite, listScraperIds, resolveScraper };

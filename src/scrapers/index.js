const tixcraft = require('./tixcraft');

const scrapers = [
  {
    id: 'tixcraft',
    label: '拓元 / tixcraft',
    matches: tixcraft.matches,
    scrape: tixcraft.scrapeTixcraft,
  },
];

function resolveScraper(url, scraperId) {
  if (scraperId) {
    const byId = scrapers.find((s) => s.id === scraperId);
    if (byId) return byId;
  }
  return scrapers.find((s) => s.matches(url)) ?? null;
}

function listScraperIds() {
  return scrapers.map((s) => ({ id: s.id, label: s.label }));
}

async function scrapeSite(site) {
  const scraper = resolveScraper(site.url, site.scraperId);
  if (!scraper) {
    throw new Error(`No scraper found for URL: ${site.url}`);
  }
  const result = await scraper.scrape(site.url);
  return result;
}

module.exports = { scrapeSite, listScraperIds };

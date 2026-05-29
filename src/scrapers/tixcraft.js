const { withPage, simulateHumanBehavior } = require('./browser');

const IGNORE_KEYWORDS = ['輪椅', '身障'];

function shouldIgnoreSection(name) {
  return IGNORE_KEYWORDS.some((kw) => name.includes(kw));
}

function classifySection(raw) {
  const name = raw.name || '';
  if (shouldIgnoreSection(name)) {
    return { ...raw, status: 'ignored', remaining: raw.remaining ?? 0 };
  }
  if (raw.available || raw.hotSelling || raw.remaining > 0) {
    return {
      ...raw,
      status: 'available',
      remaining: raw.remaining > 0 ? raw.remaining : null,
    };
  }
  if (raw.soldOut) {
    return { ...raw, status: 'soldOut', remaining: 0 };
  }
  return { ...raw, status: 'soldOut', remaining: 0 };
}

function summarize(sections) {
  let availableCount = 0;
  let soldOutCount = 0;
  let ignoredCount = 0;
  for (const s of sections) {
    if (s.status === 'available') availableCount += 1;
    else if (s.status === 'ignored') ignoredCount += 1;
    else soldOutCount += 1;
  }
  return { availableCount, soldOutCount, ignoredCount };
}

async function scrapeTixcraft(url) {
  const rawSections = await withPage(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });

    const browser = page.browser();
    if (!browser._cookieAccepted) {
      try {
        const acceptBtn = await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 3000 });
        if (acceptBtn) {
          await acceptBtn.click();
        }
      } catch (err) {
        // 忽略找不到或超時的情況
      }
      // 標記這個瀏覽器實例已經處理過 Cookie 視窗
      browser._cookieAccepted = true;
    }

    await page.waitForSelector('ul.area-list li, .area-list li, ul li', { timeout: 30_000 });

    // 模擬人類瀏覽行為
    await simulateHumanBehavior(page);

    return page.evaluate(() => {
      const items = [];
      const seen = new Set();
      const NAV_BLOCKLIST = /^(Events|My Tickets|Sign In|Menu|Home|Clear|Search)/i;

      const listRoots = document.querySelectorAll('ul.area-list, .zone.area-list');
      const lis =
        listRoots.length > 0
          ? Array.from(listRoots).flatMap((root) => [...root.querySelectorAll('li')])
          : [...document.querySelectorAll('li')];

      for (const li of lis) {
        const anchor = li.querySelector('a');
        const font = li.querySelector('font');
        const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || NAV_BLOCKLIST.test(text)) continue;

        const hasZone =
          /\d+區/.test(text) ||
          /區.*\d{3,4}/.test(text) ||
          /[Ａ-ＺA-Za-z]區/.test(text);
        if (!hasZone) continue;

        const id = anchor?.id || null;
        const isSelectable = [...li.classList].some((c) => c.startsWith('select_form_'));
        const fontColor = font?.getAttribute('color')?.toUpperCase() || '';
        const fontText = (font?.textContent || '').replace(/\s+/g, ' ').trim();

        let remaining = 0;
        const remainZh = text.match(/剩餘\s*(\d+)/);
        const remainEn = text.match(/(\d+)\s*seat\(s\)\s*remaining/i);
        if (remainZh) remaining = parseInt(remainZh[1], 10);
        else if (remainEn) remaining = parseInt(remainEn[1], 10);

        const hotSelling = /熱賣中|熱銷中/i.test(text) || /熱賣中|熱銷中/i.test(fontText);
        const explicitlySoldOut = /已售完/i.test(text) || /Sold\s*out/i.test(text);
        const graySoldOut = fontColor === '#AAAAAA' && explicitlySoldOut;

        const soldOut = explicitlySoldOut || graySoldOut || (!anchor && !isSelectable);

        const available =
          !soldOut &&
          isSelectable &&
          Boolean(anchor) &&
          (remaining > 0 || hotSelling || fontColor === '#FF0000');

        let name = text
          .replace(/剩餘\s*\d+/g, '')
          .replace(/\d+\s*seat\(s\)\s*remaining/gi, '')
          .replace(/熱賣中|熱銷中/gi, '')
          .replace(/已售完/gi, '')
          .replace(/Sold\s*out/gi, '')
          .trim();

        if (!name || name.length < 2) continue;

        const dedupeKey = `${id || ''}:${name}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        items.push({
          id,
          name,
          remaining: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
          hotSelling,
          available,
          soldOut: !available,
          clickable: isSelectable && Boolean(anchor),
        });
      }

      return items;
    });
  });

  const sections = rawSections.map(classifySection).sort((a, b) => {
    const order = { available: 0, soldOut: 1, ignored: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9);
  });

  return {
    scraperId: 'tixcraft',
    scrapedAt: new Date().toISOString(),
    sections,
    summary: summarize(sections),
  };
}

function matches(url) {
  return /tixcraft\.com\/ticket\/area\//i.test(url);
}

module.exports = { scrapeTixcraft, matches };

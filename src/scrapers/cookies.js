const fs = require('fs/promises');
const path = require('path');
const log = require('../logger');

const COOKIES_DIR = path.join(__dirname, '../../data/cookies');

/**
 * 從 page 取出 cookie 並存到磁碟（按 domain 分檔）。
 * 作為 userDataDir 之外的第二道保險。
 */
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    if (!cookies.length) return;

    await fs.mkdir(COOKIES_DIR, { recursive: true });

    // 按頂級 domain 分組
    const byDomain = {};
    for (const c of cookies) {
      const key = extractDomain(c.domain);
      if (!byDomain[key]) byDomain[key] = [];
      byDomain[key].push(c);
    }

    for (const [domain, list] of Object.entries(byDomain)) {
      const file = path.join(COOKIES_DIR, `${domain}.json`);
      await fs.writeFile(file, JSON.stringify(list, null, 2), 'utf8');
    }

    log.info('cookies', `已備份 ${cookies.length} 個 cookie（${Object.keys(byDomain).length} 個 domain）`);
  } catch (err) {
    log.warn('cookies', `備份 cookie 失敗: ${err.message}`);
  }
}

/**
 * 從磁碟載入 cookie 到 page（根據 URL 的 domain 選擇檔案）。
 */
async function loadCookies(page, url) {
  try {
    const domain = extractDomain(new URL(url).hostname);
    const file = path.join(COOKIES_DIR, `${domain}.json`);

    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      // 檔案不存在 → 第一次訪問，正常
      return 0;
    }

    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return 0;

    // 過濾掉已過期的 cookie
    const now = Date.now() / 1000;
    const valid = cookies.filter((c) => !c.expires || c.expires === -1 || c.expires > now);

    if (valid.length > 0) {
      await page.setCookie(...valid);
      log.info('cookies', `已載入 ${valid.length} 個 cookie（${domain}）`);
    }

    return valid.length;
  } catch (err) {
    log.warn('cookies', `載入 cookie 失敗: ${err.message}`);
    return 0;
  }
}

/**
 * 從 cookie domain 或 hostname 提取頂級 domain（如 tixcraft.com）。
 */
function extractDomain(raw) {
  const host = raw.startsWith('.') ? raw.slice(1) : raw;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

module.exports = { saveCookies, loadCookies };

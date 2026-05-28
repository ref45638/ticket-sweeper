const { connect } = require('puppeteer-real-browser');
const path = require('path');
const config = require('../config/env');
const log = require('../logger');
const { saveCookies, loadCookies } = require('./cookies');

const PROFILE_DIR = path.join(__dirname, '../../data/browser-profile');

// 隨機 viewport 尺寸池，避免每次都是固定 1280×800
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

let browserInstance = null;
let connectingPromise = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (connectingPromise) {
    return connectingPromise;
  }

  connectingPromise = (async () => {
    try {
      log.info('browser', '正在啟動 puppeteer-real-browser…');

      const { browser } = await connect({
        headless: config.browserHeadless ? 'auto' : false,
        turnstile: true,
        fingerprint: true,
        customConfig: {
          userDataDir: PROFILE_DIR,
        },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // 如果 headless=false，把視窗藏到螢幕外
          ...(config.browserHeadless ? [] : ['--window-position=-32000,-32000']),
        ],
        connectOption: {
          defaultViewport: null,
        },
        disableXvfb: false,
      });

      browserInstance = browser;

      browser.on('disconnected', () => {
        log.warn('browser', '瀏覽器已斷開連線');
        browserInstance = null;
      });

      log.info('browser', '瀏覽器已啟動（puppeteer-real-browser）');
      return browser;
    } catch (err) {
      browserInstance = null;
      throw err;
    } finally {
      connectingPromise = null;
    }
  })();

  return connectingPromise;
}

async function isBrowserAlive() {
  try {
    const browser = await getBrowser();
    return browser.isConnected();
  } catch {
    return false;
  }
}

async function resetBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      /* ignore */
    }
    browserInstance = null;
  }
  connectingPromise = null;
}

/**
 * 模擬人類瀏覽行為：隨機滾動、短暫停頓。
 * 在擷取資料前呼叫，讓請求看起來更自然。
 */
async function simulateHumanBehavior(page) {
  // 隨機等待 0.5~2 秒
  await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 1500)));

  // 隨機滾動 1~3 次
  const scrolls = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrolls; i++) {
    const distance = 100 + Math.floor(Math.random() * 400);
    await page.evaluate((d) => window.scrollBy(0, d), distance);
    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 500)));
  }

  // 滾回頂部（確保能擷取到完整列表）
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 400)));
}

async function withPage(fn, targetUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const vp = randomViewport();
    await page.setViewport(vp);

    // 載入備份的 cookie（userDataDir 已有第一層持久化，這是雙保險）
    if (targetUrl) {
      await loadCookies(page, targetUrl);
    }

    const result = await fn(page);

    // 訪問後備份 cookie 到磁碟
    await saveCookies(page);

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { getBrowser, isBrowserAlive, resetBrowser, withPage, simulateHumanBehavior };

const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs/promises');
const config = require('../config/env');
const log = require('../logger');
// 移除自訂 cookie 保存，全面信任 userDataDir 的 SQLite

const PROFILE_DIR = path.join(__dirname, '../../data/browser-profile');

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

let currentViewport = VIEWPORTS[1];
let profileCreatedAt = Date.now();
let profileLifetimeMs = getRandomLifetime();

function getRandomLifetime() {
  // 6 到 12 小時的毫秒數
  const minMs = 6 * 60 * 60 * 1000;
  const maxMs = 12 * 60 * 60 * 1000;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

let browserInstance = null;
let connectingPromise = null;

async function getBrowser() {
  // 檢查是否達到失憶時間
  if (Date.now() - profileCreatedAt > profileLifetimeMs) {
    log.warn('browser', `Profile 生命週期已達 ${Math.round(profileLifetimeMs / 3600000)} 小時，觸發定期失憶！`);
    await triggerAmnesia();
  }

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
 * 執行失憶：關閉瀏覽器、刪除 Profile 資料夾、重新抽籤
 */
async function triggerAmnesia() {
  log.info('browser', '執行失憶程序：清理 Profile 並更換特徵...');
  await resetBrowser();
  
  try {
    await fs.rm(PROFILE_DIR, { recursive: true, force: true });
    log.info('browser', '已成功刪除 Profile 資料夾 (userDataDir)');
  } catch (err) {
    log.error('browser', `刪除 Profile 資料夾失敗: ${err.message}`);
  }

  // 重新抽籤決定新的 Viewport 與生命週期
  currentViewport = getRandomViewport();
  profileLifetimeMs = getRandomLifetime();
  profileCreatedAt = Date.now();
  
  log.info('browser', `已抽籤新 Viewport: ${currentViewport.width}x${currentViewport.height}`);
  log.info('browser', `已排定下一次失憶時間: ${Math.round(profileLifetimeMs / 3600000)} 小時後`);
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

async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport(currentViewport);

    const result = await fn(page);

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = { isBrowserAlive, resetBrowser, triggerAmnesia, withPage, simulateHumanBehavior };

const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs/promises');
const config = require('../config/env');
const log = require('../logger');
// 移除自訂 cookie 保存，全面信任 userDataDir 的 SQLite

const PROFILE_DIRS = {
  scout: path.join(__dirname, '../../data/browser-profile-scout'),
  killer: path.join(__dirname, '../../data/browser-profile-killer'),
};

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

let currentViewports = {
  scout: VIEWPORTS[1],
  killer: VIEWPORTS[2],
};

let profileCreatedAt = {
  scout: Date.now(),
  killer: Date.now(),
};

let profileLifetimeMs = {
  scout: getRandomLifetime(),
  killer: getRandomLifetime(),
};

function getRandomLifetime() {
  // 6 到 12 小時的毫秒數
  const minMs = 6 * 60 * 60 * 1000;
  const maxMs = 12 * 60 * 60 * 1000;
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
}

function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

const browserInstances = { scout: null, killer: null };
const connectingPromises = { scout: null, killer: null };

async function getBrowser(role = 'scout') {
  if (!['scout', 'killer'].includes(role)) {
    role = 'scout';
  }

  // 檢查是否達到失憶時間
  if (Date.now() - profileCreatedAt[role] > profileLifetimeMs[role]) {
    log.warn('browser', `[${role.toUpperCase()}] Profile 生命週期已達 ${Math.round(profileLifetimeMs[role] / 3600000)} 小時，觸發定期失憶！`);
    await triggerAmnesia(role);
  }

  if (browserInstances[role] && browserInstances[role].isConnected()) {
    return browserInstances[role];
  }

  if (connectingPromises[role]) {
    return connectingPromises[role];
  }

  connectingPromises[role] = (async () => {
    try {
      log.info('browser', `[${role.toUpperCase()}] 正在啟動 puppeteer-real-browser…`);

      try {
        await fs.mkdir(PROFILE_DIRS[role], { recursive: true });
      } catch (err) {}

      const { browser } = await connect({
        headless: (config.browserHeadless && role !== 'killer') ? 'auto' : false,
        turnstile: true,
        fingerprint: true,
        customConfig: {
          userDataDir: PROFILE_DIRS[role],
        },
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // 如果 headless=false，把視窗藏到螢幕外 (killer 例外，維持可見)
          ...(config.browserHeadless || role === 'killer' ? [] : ['--window-position=-2000,-2000']),
        ],
        connectOption: {
          defaultViewport: null,
        },
        disableXvfb: false,
      });

      browserInstances[role] = browser;

      browser.on('disconnected', () => {
        log.warn('browser', `[${role.toUpperCase()}] 瀏覽器已斷開連線`);
        browserInstances[role] = null;
      });

      log.info('browser', `[${role.toUpperCase()}] 瀏覽器已啟動`);
      return browser;
    } catch (err) {
      browserInstances[role] = null;
      throw err;
    } finally {
      connectingPromises[role] = null;
    }
  })();

  return connectingPromises[role];
}

async function isBrowserAlive(role = 'scout') {
  try {
    const browser = await getBrowser(role);
    return browser.isConnected();
  } catch {
    return false;
  }
}

async function resetBrowser(role = 'all') {
  const rolesToReset = role === 'all' ? ['scout', 'killer'] : [role];
  
  for (const r of rolesToReset) {
    if (browserInstances[r]) {
      try {
        await browserInstances[r].close();
      } catch {
        /* ignore */
      }
      browserInstances[r] = null;
    }
    connectingPromises[r] = null;
  }
}

/**
 * 執行失憶：關閉瀏覽器、刪除 Profile 資料夾、重新抽籤
 */
async function triggerAmnesia(role = 'scout') {
  log.info('browser', `[${role.toUpperCase()}] 執行失憶程序：清理 Profile 並更換特徵...`);
  await resetBrowser(role);
  
  try {
    await fs.rm(PROFILE_DIRS[role], { recursive: true, force: true });
    log.info('browser', `[${role.toUpperCase()}] 已成功刪除 Profile 資料夾 (userDataDir)`);
    await fs.mkdir(PROFILE_DIRS[role], { recursive: true });
  } catch (err) {
    log.error('browser', `[${role.toUpperCase()}] 刪除或重建 Profile 資料夾失敗: ${err.message}`);
  }

  // 重新抽籤決定新的 Viewport 與生命週期
  currentViewports[role] = getRandomViewport();
  profileLifetimeMs[role] = getRandomLifetime();
  profileCreatedAt[role] = Date.now();
  
  log.info('browser', `[${role.toUpperCase()}] 已抽籤新 Viewport: ${currentViewports[role].width}x${currentViewports[role].height}`);
  log.info('browser', `[${role.toUpperCase()}] 已排定下一次失憶時間: ${Math.round(profileLifetimeMs[role] / 3600000)} 小時後`);
}

/**
 * 模擬人類瀏覽行為：隨機滾動、短暫停頓。
 * 在擷取資料前呼叫，讓請求看起來更自然。
 */
async function simulateHumanBehavior(page) {
  // 隨機等待 0.5~1 秒
  await new Promise((r) => setTimeout(r, 500 + Math.floor(Math.random() * 500)));

  // 隨機滾動 3~5 次
  const scrolls = 3 + Math.floor(Math.random() * 2);
  for (let i = 0; i < scrolls; i++) {
    const distance = 200 + Math.floor(Math.random() * 300);
    await page.evaluate((d) => window.scrollBy(0, d), distance);
    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 200)));
  }

  // 滾回頂部（確保能擷取到完整列表）
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 400)));
}

async function withPage(optionsOrFn, fnIfOptions) {
  let role = 'scout';
  let keepAlive = false;
  let fn = null;

  if (typeof optionsOrFn === 'function') {
    fn = optionsOrFn;
  } else {
    role = optionsOrFn.role || 'scout';
    keepAlive = optionsOrFn.keepAlive || false;
    fn = fnIfOptions;
  }

  const browser = await getBrowser(role);
  const page = await browser.newPage();
  if (keepAlive) {
    page.keepAlive = true;
  }
  
  // 透過底層注入 MutationObserver，自動且確實地點擊 Cookie 接受按鈕
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const tryClickAccept = () => {
        const btn = document.querySelector('#onetrust-accept-btn-handler');
        // offsetParent !== null 代表元素在畫面上是可見的
        if (btn && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
        return false;
      };

      // 載入完畢先嘗試點一次
      if (tryClickAccept()) return;

      // 如果還沒出來，就掛上監視器，只要 DOM 有變動就檢查
      const observer = new MutationObserver((mutations, obs) => {
        if (tryClickAccept()) {
          // 點到之後就可以把監視器關掉了，節省效能
          // （因為每次換頁都會重新觸發 evaluateOnNewDocument 掛上新的 observer）
          obs.disconnect();
        }
      });

      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
      } else {
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    });
  });

  try {
    await page.setViewport(currentViewports[role]);

    const result = await fn(page);

    return result;
  } finally {
    if (!page.keepAlive) {
      await page.close().catch(() => {});
    } else {
      log.info('browser', `[${role.toUpperCase()}] 分頁進入 Keep-Alive 模式，脫離 withPage 生命週期管理`);
    }
  }
}

async function setBrowserVisibility(role = 'scout', visible = true) {
  if (!browserInstances[role]) return;
  try {
    const browser = browserInstances[role];
    const pages = await browser.pages();
    let session = null;
    let windowId = null;

    for (const page of pages) {
      try {
        session = await page.target().createCDPSession();
        const res = await session.send('Browser.getWindowForTarget');
        windowId = res.windowId;
        break;
      } catch (e) {
        if (session) {
          await session.detach().catch(() => {});
          session = null;
        }
      }
    }

    if (session && windowId !== null) {
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: visible ? 0 : -2000, top: visible ? 0 : -2000, windowState: 'normal' }
      });
      await session.detach();
    } else {
      log.warn('browser', `[${role.toUpperCase()}] 找不到可用來取得 Window ID 的頁面`);
    }
  } catch (err) {
    log.error('browser', `[${role.toUpperCase()}] 切換視窗顯示失敗: ${err.message}`);
  }
}

async function setAllBrowsersVisibility(visible = true) {
  // 只控制 scout 視窗，killer 維持顯示不隱藏
  await setBrowserVisibility('scout', visible);
}

module.exports = { isBrowserAlive, resetBrowser, triggerAmnesia, withPage, simulateHumanBehavior, setAllBrowsersVisibility };

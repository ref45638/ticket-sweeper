const config = require('./config/env');
const sitesStore = require('./config/sites');
const { scrapeSite } = require('./scrapers');
const { fetchCaptcha } = require('./scrapers/tixcraft');
const { resetBrowser, triggerAmnesia } = require('./scrapers/browser');
const state = require('./state');
const notifier = require('./notifier');
const log = require('./logger');
const settings = require('./config/settings');

let timeoutId = null;
let scrapeInProgress = false;
let consecutiveBlocks = 0; // 連續被 WAF 阻擋的次數

function randomDelay(minMs = 3000, maxMs = 5000) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/** 凌晨 03:00~09:00 降頻區間（本機時區） */
const QUIET_HOUR_START = 3;
const QUIET_HOUR_END = 9;
const QUIET_INTERVAL_MS = 300_000; // 5 分鐘

/** jitter 範圍（±秒） */
const JITTER_RANGE_MS = 15_000;

/**
 * 計算下一次執行的延遲毫秒數。
 * - 正常時段：baseInterval ± 15 秒隨機 jitter
 * - 凌晨 03~09：5 分鐘 ± 15 秒
 */
function getNextDelay() {
  const hour = new Date().getHours();
  const isQuiet = hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END;
  const baseMs = isQuiet ? QUIET_INTERVAL_MS : config.scrapeIntervalMs;
  const jitter = Math.floor(Math.random() * JITTER_RANGE_MS * 2) - JITTER_RANGE_MS;
  return Math.max(10_000, baseMs + jitter); // 最少 10 秒
}

function publishNextRun(nextDate, actualIntervalMs) {
  const hour = new Date().getHours();
  const isQuiet = hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END;
  state.setSchedulerMeta({
    nextRunAt: nextDate.toISOString(),
    scrapeIntervalMs: actualIntervalMs,
    scheduleMode: isQuiet ? 'quiet-jitter' : 'jitter',
  });
  return nextDate;
}

function scheduleNextTick() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  const delayMs = getNextDelay();
  const next = new Date(Date.now() + delayMs);
  publishNextRun(next, delayMs);

  const hour = new Date().getHours();
  const isQuiet = hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END;
  log.info('scheduler', `下次輪詢 ${next.toLocaleString('zh-TW', { hour12: false })}（${Math.ceil(delayMs / 1000)} 秒後）${isQuiet ? '（降頻模式 03~09）' : ''}`);

  timeoutId = setTimeout(() => {
    timeoutId = null;
    runScrapeCycle()
      .catch((err) => {
        log.error('scheduler', '週期錯誤', err.message);
      })
      .finally(() => {
        scheduleNextTick();
      });
  }, delayMs);
}

async function scrapeOneSite(site) {
  const started = Date.now();
  log.info('scraper', `開始抓取: ${site.label}`, site.url);

  try {
    const result = await scrapeSite(site);
    state.setSiteResult(site.id, {
      label: site.label,
      url: site.url,
      scraperId: site.scraperId,
      lastScrapedAt: result.scrapedAt,
      error: null,
      sections: result.sections,
      summary: result.summary,
    });

    const { availableCount } = result.summary;
    log.info('scraper', `完成: ${site.label} (${((Date.now() - started) / 1000).toFixed(1)}s) — 可購 ${availableCount} 區`);

    const notifyOutcomes = await notifier.notifyForSiteResult(site, result);
    const notified = notifyOutcomes.some((o) => o.notified);
    if (notified) {
      log.info('notifier', `已發送通知: ${site.label}`);
    }

    // 加車流程結果通知
    if (result.cartResult) {
      state.recordStat('cartTotal');
      const globalSettings = await settings.getSettings();
      const notifyEvents = globalSettings.notifyEvents || {};

      let cartMsg = '';
      let shouldNotify = false;

      if (result.cartResult.needManualCaptcha) {
        state.recordStat('captchaEvents');
        if (notifyEvents.cartManualCaptcha !== false) {
          shouldNotify = true;
          cartMsg = `🚨 搶票中！已為您填好票數與條款\n\n活動：${site.label}\n\n⚠️ 需要手動填寫驗證碼！\n請立即切換到瀏覽器視窗完成操作！\n\n⏰ 鎖票保留約 10 分鐘`;
        }
      } else if (result.cartResult.success) {
        state.recordStat('cartSuccess');
        if (notifyEvents.cartSuccess !== false) {
          shouldNotify = true;
          cartMsg = `🎉 發現有票，準備搶票！\n\n活動：${site.label}\n${result.cartResult.message}\n\n${site.url}`;
        }
      } else {
        if (notifyEvents.cartFailure === true) {
          shouldNotify = true;
          cartMsg = `⚠️ 加車失敗\n\n活動：${site.label}\n原因：${result.cartResult.message}`;
        }
      }

      if (shouldNotify) {
        await notifier.sendDirect(cartMsg);
        log.info('notifier', `已發送加車通知: ${result.cartResult.message}`);
      }
    }

    return { siteId: site.id, ok: true };
  } catch (err) {
    log.error('scraper', `失敗: ${site.label}`, err.message);
    state.setSiteResult(site.id, {
      label: site.label,
      url: site.url,
      scraperId: site.scraperId,
      lastScrapedAt: new Date().toISOString(),
      error: err.message,
      sections: [],
      summary: { availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
    });

    try {
      const globalSettings = await settings.getSettings();
      if (globalSettings.notifyEvents && globalSettings.notifyEvents.scraperError !== false) {
        // 為了避免太過頻繁通知，這裡其實可以做冷卻，但暫時直接送
        await notifier.sendDirect(`⚠️ 爬蟲發生錯誤\n\n活動：${site.label}\n錯誤：${err.message}`);
      }
    } catch (e) {
      // ignore
    }

    return { siteId: site.id, ok: false, error: err.message };
  }
}

async function runScrapeCycle() {
  if (scrapeInProgress) {
    log.warn('scheduler', '上一輪尚未結束，略過本次觸發');
    return { skipped: true };
  }

  scrapeInProgress = true;
  const startedAt = new Date();
  state.setSchedulerMeta({
    running: true,
    lastRunAt: startedAt.toISOString(),
    lastError: null,
  });

  log.info('scheduler', '輪詢週期開始');

  const outcomes = [];
  try {
    const sites = await sitesStore.listEnabledSites();
    log.info('scheduler', `啟用站點數: ${sites.length}`);

    if (sites.length === 0) {
      log.warn('scheduler', '沒有啟用的監控站點');
    }

    for (const site of sites) {
      outcomes.push(await scrapeOneSite(site));
      await randomDelay();
    }

    // 偷抓拓元驗證碼圖片
    const globalSettings = await settings.getSettings();
    if (globalSettings.fetchCaptchaImage !== false) {
      log.info('scheduler', '偷抓拓元驗證碼圖片');
      await fetchCaptcha();
    }
  } catch (err) {
    log.error('scheduler', '週期異常', err.message);
    state.setSchedulerMeta({ lastError: err.message });
    if (/Target closed|Session closed|Protocol error/i.test(err.message)) {
      log.warn('scheduler', '重置 Puppeteer browser');
      await resetBrowser('scout');
      await resetBrowser('killer');
    }
  } finally {
    scrapeInProgress = false;
    state.setSchedulerMeta({ running: false });
    const elapsed = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    const ok = outcomes.filter((o) => o.ok).length;

    state.recordStat('scrapesTotal', outcomes.length);
    state.recordStat('scrapesSuccess', ok);
    state.recordStat('scrapesError', outcomes.length - ok);

    log.info('scheduler', `輪詢週期結束 (${elapsed}s) — 成功 ${ok}/${outcomes.length}`);

    // 檢查是否有被 WAF 阻擋的情況
    const blocked = outcomes.some((o) => !o.ok && o.error && /403|turnstile|access denied|cloudflare|blocked/i.test(o.error));

    if (blocked) {
      consecutiveBlocks++;
      log.warn('scheduler', `偵測到疑似 WAF 阻擋，連續阻擋次數：${consecutiveBlocks}`);
      if (consecutiveBlocks >= 3) {
        log.error('scheduler', '連續 3 次被阻擋，觸發強制失憶！');
        await triggerAmnesia('scout');
        consecutiveBlocks = 0; // 重置計數
      }
    } else if (ok > 0) {
      // 只要有任何一個站點成功，就代表 Session 狀態正常，歸零阻擋計數
      if (consecutiveBlocks > 0) {
        log.info('scheduler', '成功獲取資料，阻擋計數歸零。');
      }
      consecutiveBlocks = 0;
    }
  }

  return { outcomes, finishedAt: new Date().toISOString() };
}

function startScheduler() {
  if (timeoutId) return;

  const stepMin = config.scrapeIntervalMs / 60_000;
  log.info('scheduler', `排程啟動（隨機 jitter），基礎間隔 ${stepMin >= 1 && Number.isInteger(stepMin) ? `${stepMin} 分鐘` : `${config.scrapeIntervalMs / 1000} 秒`}，凌晨 03~09 降頻 5 分鐘`);

  scheduleNextTick();
}

function stopScheduler() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    log.info('scheduler', '排程已停止');
  }
}

async function scrapeSiteById(siteId) {
  const site = await sitesStore.getSiteById(siteId);
  if (!site) throw new Error('Site not found');
  log.info('scheduler', `手動觸發: ${site.label}`);
  return scrapeOneSite(site);
}

module.exports = {
  startScheduler,
  stopScheduler,
  scrapeSiteById,
  isScrapeInProgress: () => scrapeInProgress,
};

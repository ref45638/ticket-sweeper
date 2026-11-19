const sitesStore = require('./config/sites');
const { scrapeSite, resolveScraper } = require('./scrapers');
const { fetchCaptcha, keepKillerWarm, refreshScoutSessions, isTixcraftSite } = require('./scrapers/tixcraft');
const { resetBrowser, triggerAmnesia } = require('./scrapers/browser');
const state = require('./state');
const notifier = require('./notifier');
const log = require('./logger');
const settings = require('./config/settings');

let timeoutId = null;
let scrapeInProgress = false;
let consecutiveBlocks = 0; // 連續被 WAF 阻擋的次數
let warmTimer = null; // Killer 保溫定時器（方案 A）
const WARM_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分鐘刷新一次 Killer 的 Cloudflare 通行

function randomDelay(minMs = 3000, maxMs = 5000) {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 間隔與降頻時段都來自設定頁（settings.json），每輪排下一次時重讀，改完下一輪就生效。
 * jitter 範圍（±毫秒）維持固定。
 */
const JITTER_RANGE_MS = 15_000;

/**
 * 遠大獨立輪詢：走純 HTTP 公開 API、成本低，而清票常在幾十秒內被搶光，故預設比拓元主輪詢密；
 * 降頻時段一樣降頻。
 */
let ticketplusTimeoutId = null;
const TICKETPLUS_JITTER_MS = 5_000;

const isTicketplusSite = (site) => resolveScraper(site.url, site.scraperId)?.id === 'ticketplus';

/**
 * 同一站連續失敗達門檻才推播錯誤（只在剛好達到時推一次，成功一次就歸零）。
 * 像遠大回源偶發逾時這種單次失敗，下一輪通常就恢復，不必每次都推。
 */
const ERROR_NOTIFY_THRESHOLD = 3;
const consecutiveErrors = new Map(); // siteId → 連續失敗次數

/** 是否落在降頻時段（本機時區整點）。起訖相同=不降頻；起 > 訖=跨午夜（例：23→6） */
function isQuietHour(s, hour = new Date().getHours()) {
  const start = s.quietStartHour;
  const end = s.quietEndHour;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const quietText = (s) => (s.quietStartHour === s.quietEndHour ? '不降頻' : `${String(s.quietStartHour).padStart(2, '0')}~${String(s.quietEndHour).padStart(2, '0')} 降頻 ${s.quietIntervalMs / 1000} 秒`);

/**
 * 計算下一次執行的延遲毫秒數（拓元主輪詢與遠大獨立輪詢各傳自己的間隔與 jitter）。
 * - 一般時段：normalMs ± jitterMs 隨機 jitter
 * - 降頻時段：s.quietIntervalMs ± jitterMs
 */
function getNextDelay(normalMs, jitterMs, s) {
  const baseMs = isQuietHour(s) ? s.quietIntervalMs : normalMs;
  const jitter = Math.floor(Math.random() * jitterMs * 2) - jitterMs;
  return Math.max(10_000, baseMs + jitter); // 最少 10 秒
}

function publishNextRun(nextDate, actualIntervalMs, isQuiet) {
  state.setSchedulerMeta({
    nextRunAt: nextDate.toISOString(),
    scrapeIntervalMs: actualIntervalMs,
    scheduleMode: isQuiet ? 'quiet-jitter' : 'jitter',
  });
  return nextDate;
}

async function scheduleNextTick() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  const s = await settings.getSettings();
  const isQuiet = isQuietHour(s);
  const delayMs = getNextDelay(s.scrapeIntervalMs, JITTER_RANGE_MS, s);
  const next = new Date(Date.now() + delayMs);
  publishNextRun(next, delayMs, isQuiet);

  log.info('scheduler', `下次輪詢 ${next.toLocaleString('zh-TW', { hour12: false })}（${Math.ceil(delayMs / 1000)} 秒後）${isQuiet ? `（降頻模式 ${quietText(s)}）` : ''}`);

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
    consecutiveErrors.delete(site.id);
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
    const failCount = (consecutiveErrors.get(site.id) || 0) + 1;
    consecutiveErrors.set(site.id, failCount);
    log.error('scraper', `失敗: ${site.label}（連續 ${failCount} 次）`, err.message);
    state.setSiteResult(site.id, {
      label: site.label,
      url: site.url,
      scraperId: site.scraperId,
      lastScrapedAt: new Date().toISOString(),
      error: err.message,
      sections: [],
      summary: { availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
    });

    if (failCount === ERROR_NOTIFY_THRESHOLD) {
      try {
        const globalSettings = await settings.getSettings();
        if (globalSettings.notifyEvents && globalSettings.notifyEvents.scraperError !== false) {
          await notifier.sendDirect(`⚠️ 爬蟲連續 ${failCount} 次發生錯誤\n\n活動：${site.label}\n錯誤：${err.message}`);
        }
      } catch (e) {
        // ignore
      }
    }

    return { siteId: site.id, ok: false, error: err.message, isTixcraft: isTixcraftSite(site) };
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
    const allSites = await sitesStore.listEnabledSites();
    // 遠大站點由 runTicketplusCycle 以較短間隔另行輪詢，這裡只跑拓元等其他站
    const sites = allSites.filter((s) => !isTicketplusSite(s));
    log.info('scheduler', `啟用站點數: ${sites.length}（遠大 ${allSites.length - sites.length} 個另行輪詢）`);

    if (allSites.length === 0) {
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

    // 檢查是否有被 WAF 阻擋的情況（只算拓元站：失憶的是拓元 Scout，遠大等其他站的錯誤與它無關）
    const blocked = outcomes.some((o) => !o.ok && o.isTixcraft && o.error && /403|turnstile|access denied|cloudflare|blocked/i.test(o.error));

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

  settings.getSettings().then((s) => {
    log.info('scheduler', `排程啟動（隨機 jitter）：拓元 ${s.scrapeIntervalMs / 1000}±${JITTER_RANGE_MS / 1000} 秒、遠大 ${s.ticketplusIntervalMs / 1000}±${TICKETPLUS_JITTER_MS / 1000} 秒，${quietText(s)}（設定頁可調，下一輪生效）`);
  });

  scheduleNextTick();
  scheduleTicketplusTick();
  scheduleDailyReport();
  startKillerWarmer();
}

function stopScheduler() {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    log.info('scheduler', '排程已停止');
  }
  if (ticketplusTimeoutId) {
    clearTimeout(ticketplusTimeoutId);
    ticketplusTimeoutId = null;
  }
  if (reportTimeoutId) {
    clearTimeout(reportTimeoutId);
    reportTimeoutId = null;
  }
  stopKillerWarmer();
}

/** 每天固定時點（本機時區）推播監控統整報告，沒票時也發，讓人知道服務還活著 */
const REPORT_HOURS = [9, 21];
let reportTimeoutId = null;
let statsAtLastReport = state.getStats();

function scheduleDailyReport() {
  const now = new Date();
  const next = REPORT_HOURS.map((h) => {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }).sort((a, b) => a - b)[0];

  reportTimeoutId = setTimeout(() => {
    sendDailyReport()
      .catch((err) => log.error('scheduler', '統整報告發送失敗', err.message))
      .finally(() => {
        if (reportTimeoutId) scheduleDailyReport();
      });
  }, next - now);
}

async function sendDailyReport() {
  const stats = state.getStats();
  const checks = stats.scrapesTotal - statsAtLastReport.scrapesTotal;
  const errors = stats.scrapesError - statsAtLastReport.scrapesError;
  statsAtLastReport = stats;

  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
  const results = state.getAllResults();
  const lines = results.map((r, i) => {
    const prefix = i === results.length - 1 ? '└ ' : '├ ';
    const status = r.error ? `⚠️ 錯誤：${r.error}` : r.summary?.availableCount > 0 ? `🎫 可購 ${r.summary.availableCount} 區` : '售完';
    return `${prefix}${r.label}：${status}（最後檢查 ${time(r.lastScrapedAt)}）`;
  });

  const header = `📊 監控統整報告（${new Date().toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}）`;
  const body = lines.length ? lines.join('\n') : '（目前沒有監控中的活動）';
  await notifier.sendDirect(`${header}\n\n服務運作中，距上次報告共檢查 ${checks} 次、失敗 ${errors} 次\n\n${body}`);
  log.info('scheduler', '已發送統整報告');
}

/**
 * 遠大獨立輪詢：與拓元主輪詢並行、互不阻塞，只做偵測與通知（scrapeOneSite），沒有加車、WAF 失憶等拓元專屬流程。
 * 下一輪在本輪結束後才排，故不會重疊；停止排程後（ticketplusTimeoutId 被清空）不再續排。
 * 為免洗版不印週期 log，逐站結果仍由 scrapeOneSite 記錄。
 */
async function scheduleTicketplusTick() {
  const s = await settings.getSettings();
  ticketplusTimeoutId = setTimeout(
    () => {
      runTicketplusCycle()
        .catch((err) => log.error('scheduler', '遠大輪詢錯誤', err.message))
        .finally(() => {
          if (ticketplusTimeoutId) scheduleTicketplusTick();
        });
    },
    getNextDelay(s.ticketplusIntervalMs, TICKETPLUS_JITTER_MS, s)
  );
}

async function runTicketplusCycle() {
  const sites = (await sitesStore.listEnabledSites()).filter(isTicketplusSite);
  for (const site of sites) {
    const { ok } = await scrapeOneSite(site);
    state.recordStat('scrapesTotal');
    state.recordStat(ok ? 'scrapesSuccess' : 'scrapesError');
  }
}

/**
 * 背景定期維護（方案 A + 免渲染主動刷新）：以 WARM_INTERVAL_MS 節奏同時做兩件事——
 *  1. keepKillerWarm：依 warmKiller 開關保溫 Killer 的 Cloudflare 通行或關閉閒置瀏覽器。
 *  2. refreshScoutSessions：fast 模式下主動刷新常駐 Scout 分頁的 cf_clearance（純 fetch 不會續票），
 *     避免每隔十幾～三十分鐘就有一輪偵測被動 fallback 變慢甚至錯過開賣瞬間。
 * 兩者內部各自依設定決定行為，故這個 timer 一律啟動。
 */
function startKillerWarmer() {
  if (warmTimer) return;
  const tick = () => {
    keepKillerWarm().catch((e) => log.warn('scheduler', `保溫例外: ${e.message}`));
    refreshScoutSessions().catch((e) => log.warn('scheduler', `Scout 刷新例外: ${e.message}`));
  };
  // 啟動後稍等再跑一次，避免和開機其他初始化搶資源
  setTimeout(tick, 15_000);
  warmTimer = setInterval(tick, WARM_INTERVAL_MS);
}

function stopKillerWarmer() {
  if (warmTimer) {
    clearInterval(warmTimer);
    warmTimer = null;
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
  isQuietHour,
};

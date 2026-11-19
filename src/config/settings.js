const fs = require('fs/promises');
const path = require('path');
const log = require('../logger');
const config = require('./env');

const SETTINGS_PATH = path.join(__dirname, '../settings.json');

/** 輪詢間隔下限，與 scheduler 的最低延遲一致 */
const MIN_INTERVAL_MS = 10_000;

const DEFAULTS = {
  tixuisid: '',
  ticketQuantity: 1,
  unattendedMode: true,
  notifyEvents: {
    ticketFound: false,
    cartManualCaptcha: true,
    cartSuccess: true,
    cartFailure: false,
    scraperError: true,
  },
  fetchCaptchaImage: true,
  warmKiller: false,
  // 偵測策略：'fast'=免渲染 in-context fetch（預設）、'render'=舊渲染偵測（一鍵切回的安全開關）
  detectionMode: 'fast',
  // 輪詢排程（scheduler 每輪重讀，改完下一輪生效）。拓元間隔沒存過時沿用 .env 的 SCRAPE_INTERVAL_MS
  scrapeIntervalMs: config.scrapeIntervalMs,
  ticketplusIntervalMs: 15_000,
  // 降頻時段（本機時區整點）：起訖相同=不降頻；起 > 訖=跨午夜
  quietStartHour: 3,
  quietEndHour: 9,
  quietIntervalMs: 300_000,
};

async function readSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const data = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...data,
      notifyEvents: {
        ...DEFAULTS.notifyEvents,
        ...(data.notifyEvents || {}),
      },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

async function writeSettings(settings) {
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

async function getSettings() {
  return readSettings();
}

async function patchSettings(patch) {
  const current = await readSettings();
  if (patch.tixuisid !== undefined) {
    current.tixuisid = String(patch.tixuisid).trim();
  }
  if (patch.ticketQuantity !== undefined) {
    const qty = parseInt(patch.ticketQuantity, 10);
    current.ticketQuantity = Number.isFinite(qty) && qty >= 1 ? qty : 1;
  }
  if (patch.notifyEvents !== undefined && typeof patch.notifyEvents === 'object') {
    current.notifyEvents = {
      ...current.notifyEvents,
      ...patch.notifyEvents,
    };
  }
  if (patch.fetchCaptchaImage !== undefined) {
    current.fetchCaptchaImage = Boolean(patch.fetchCaptchaImage);
  }
  if (patch.unattendedMode !== undefined) {
    current.unattendedMode = Boolean(patch.unattendedMode);
  }
  if (patch.warmKiller !== undefined) {
    current.warmKiller = Boolean(patch.warmKiller);
  }
  if (patch.detectionMode !== undefined) {
    current.detectionMode = patch.detectionMode === 'render' ? 'render' : 'fast';
  }
  // 非數字（含 null）一律維持原值；間隔低於下限時拉到下限
  for (const key of ['scrapeIntervalMs', 'ticketplusIntervalMs', 'quietIntervalMs']) {
    const ms = parseInt(patch[key], 10);
    if (Number.isFinite(ms)) current[key] = Math.max(MIN_INTERVAL_MS, ms);
  }
  for (const key of ['quietStartHour', 'quietEndHour']) {
    const hour = parseInt(patch[key], 10);
    if (hour >= 0 && hour <= 23) current[key] = hour;
  }
  await writeSettings(current);
  const n = current.notifyEvents || {};
  const notifyStr = `[有票=${n.ticketFound ? '開' : '關'}, 手動驗證=${n.cartManualCaptcha ? '開' : '關'}, 成功=${n.cartSuccess ? '開' : '關'}, 失敗=${n.cartFailure ? '開' : '關'}, 錯誤=${n.scraperError ? '開' : '關'}]`;
  const msg = `tixuisid=${current.tixuisid ? '***' : '(空)'}, 票數=${current.ticketQuantity}, 偵測=${current.detectionMode}, 離座模式=${current.unattendedMode ? '開' : '關'}, 保溫Killer=${current.warmKiller ? '開' : '關'}, 偷抓驗證碼=${current.fetchCaptchaImage ? '開' : '關'}, 推播=${notifyStr}, 排程=[拓元 ${current.scrapeIntervalMs / 1000}s, 遠大 ${current.ticketplusIntervalMs / 1000}s, 降頻 ${current.quietStartHour}~${current.quietEndHour} 點 ${current.quietIntervalMs / 1000}s]`;
  log.info('settings', `已更新全域設定: ${msg}`);
  return current;
}

module.exports = { getSettings, patchSettings, DEFAULTS };

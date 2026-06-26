const fs = require('fs/promises');
const path = require('path');
const log = require('../logger');

const SETTINGS_PATH = path.join(__dirname, '../settings.json');

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
  await writeSettings(current);
  const n = current.notifyEvents || {};
  const notifyStr = `[有票=${n.ticketFound?'開':'關'}, 手動驗證=${n.cartManualCaptcha?'開':'關'}, 成功=${n.cartSuccess?'開':'關'}, 失敗=${n.cartFailure?'開':'關'}, 錯誤=${n.scraperError?'開':'關'}]`;
  const msg = `tixuisid=${current.tixuisid ? '***' : '(空)'}, 票數=${current.ticketQuantity}, 離座模式=${current.unattendedMode?'開':'關'}, 保溫Killer=${current.warmKiller?'開':'關'}, 偷抓驗證碼=${current.fetchCaptchaImage?'開':'關'}, 推播=${notifyStr}`;
  log.info('settings', `已更新全域設定: ${msg}`);
  return current;
}

module.exports = { getSettings, patchSettings };

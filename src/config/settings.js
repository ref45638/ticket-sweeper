const fs = require('fs/promises');
const path = require('path');
const log = require('../logger');

const SETTINGS_PATH = path.join(__dirname, '../settings.json');

const DEFAULTS = {
  tixuisid: '',
  ticketQuantity: 1,
  notifyEvents: {
    ticketFound: false,
    cartManualCaptcha: true,
    cartSuccess: true,
    cartFailure: false,
    scraperError: true,
  },
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
  await writeSettings(current);
  log.info('settings', `已更新全域設定: tixuisid=${current.tixuisid ? '***' : '(空)'}, 票數=${current.ticketQuantity}`);
  return current;
}

module.exports = { getSettings, patchSettings };

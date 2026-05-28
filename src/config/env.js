require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

function boolEnv(key, defaultValue) {
  const v = process.env[key];
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1';
}

function intEnv(key, defaultValue, min = 0) {
  const v = parseInt(process.env[key], 10);
  if (!Number.isFinite(v)) return defaultValue;
  return Math.max(min, v);
}

const config = {
  port: intEnv('PORT', 3000),
  scrapeIntervalMs: intEnv('SCRAPE_INTERVAL_MS', 60_000, 10_000),
  notifyCooldownMs: intEnv('NOTIFY_COOLDOWN_MS', 600_000),
  browserHeadless: boolEnv('BROWSER_HEADLESS', boolEnv('PUPPETEER_HEADLESS', false)),
  line: {
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    targetId: process.env.LINE_TARGET_ID || '',
    enabled() {
      return Boolean(this.token && this.targetId);
    },
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    enabled() {
      return Boolean(this.botToken && this.chatId);
    },
  },
};

module.exports = config;

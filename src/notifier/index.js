const line = require('./line');
const telegram = require('./telegram');
const cooldown = require('./cooldown');
const log = require('../logger');

function formatStockLine(section) {
  if (section.remaining != null && section.remaining > 0) {
    return `剩餘：${section.remaining} 張`;
  }
  if (section.hotSelling) {
    return '狀態：熱賣中（未顯示張數）';
  }
  return '狀態：可購買';
}

function formatAlert(site, section) {
  const lines = [
    '🎫 發現可購票區！',
    '',
    `活動：${site.label}`,
    `區域：${section.name}`,
    formatStockLine(section),
    '',
    site.url,
  ];
  if (section.id) lines.splice(4, 0, `ID：${section.id}`);
  return lines.join('\n');
}

async function notifyAvailable(site, section) {
  if (!cooldown.shouldNotify(site.id, section.name)) {
    return { notified: false, reason: 'cooldown' };
  }

  const message = formatAlert(site, section);
  const results = [];

  if (line.isEnabled()) {
    try {
      results.push(await line.send(message));
      cooldown.markNotified(site.id, section.name);
    } catch (err) {
      log.error('notifier', 'LINE 發送失敗', err.message);
      results.push({ channel: 'line', error: err.message });
    }
  }

  if (telegram.isEnabled()) {
    try {
      results.push(await telegram.send(message));
      if (!line.isEnabled()) {
        cooldown.markNotified(site.id, section.name);
      }
    } catch (err) {
      log.error('notifier', 'Telegram 發送失敗', err.message);
      results.push({ channel: 'telegram', error: err.message });
    }
  }

  const anySent = results.some((r) => r.ok);
  if (anySent && line.isEnabled() && telegram.isEnabled()) {
    cooldown.markNotified(site.id, section.name);
  }

  return { notified: anySent, results };
}

async function notifyForSiteResult(site, scrapeResult) {
  const available = scrapeResult.sections.filter((s) => s.status === 'available');
  const outcomes = [];
  for (const section of available) {
    outcomes.push(await notifyAvailable(site, section));
  }
  return outcomes;
}

function getChannelStatus() {
  return {
    line: line.isEnabled(),
    telegram: telegram.isEnabled(),
  };
}

module.exports = { notifyAvailable, notifyForSiteResult, getChannelStatus };

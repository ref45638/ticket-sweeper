const line = require('./line');
const telegram = require('./telegram');
const cooldown = require('./cooldown');
const log = require('../logger');
const settings = require('../config/settings');

function formatStockLine(section) {
  if (section.remaining != null && section.remaining > 0) {
    return `剩餘：${section.remaining} 張`;
  }
  if (section.hotSelling) {
    return '狀態：熱賣中（未顯示張數）';
  }
  return '狀態：可購買';
}

function formatAlert(site, sections) {
  const header = `🎫 【${site.label}】`;
  const link = `🔗 搶票連結：\n${site.url}`;
  
  const status = '🎯 售票狀況：\n' + sections.map((s, index, arr) => {
    const isLast = index === arr.length - 1;
    const prefix = isLast ? '└ ' : '├ ';
    const text = s.remaining !== null ? `🎫 剩 ${s.remaining} 張` : '🔥 熱賣中';
    return `${prefix}${s.name}：${text}`;
  }).join('\n');
  
  return `${header}\n\n${link}\n\n${status}`;
}

async function notifyForSiteResult(site, scrapeResult) {
  const globalSettings = await settings.getSettings();
  if (globalSettings.notifyEvents && !globalSettings.notifyEvents.ticketFound) {
    return [{ notified: false, reason: 'disabled_by_settings' }];
  }

  const available = scrapeResult.sections.filter((s) => s.status === 'available');
  if (available.length === 0) return [];

  // 過濾掉還在冷卻時間內的區域
  const toNotify = available.filter((s) => cooldown.shouldNotify(site.id, s.name));
  if (toNotify.length === 0) return [{ notified: false, reason: 'cooldown' }];

  const message = formatAlert(site, toNotify);
  const results = [];

  if (line.isEnabled()) {
    try {
      results.push(await line.send(message));
      toNotify.forEach((s) => cooldown.markNotified(site.id, s.name));
    } catch (err) {
      log.error('notifier', 'LINE 發送失敗', err.message);
      results.push({ channel: 'line', error: err.message });
    }
  }

  if (telegram.isEnabled()) {
    try {
      results.push(await telegram.send(message));
      if (!line.isEnabled()) {
        toNotify.forEach((s) => cooldown.markNotified(site.id, s.name));
      }
    } catch (err) {
      log.error('notifier', 'Telegram 發送失敗', err.message);
      results.push({ channel: 'telegram', error: err.message });
    }
  }

  const anySent = results.some((r) => r.ok);
  if (anySent && line.isEnabled() && telegram.isEnabled()) {
    toNotify.forEach((s) => cooldown.markNotified(site.id, s.name));
  }

  return [{ notified: anySent, results }];
}

/**
 * 直接發送訊息到所有啟用的通知管道（無 cooldown 限制）。
 * 用於加車成功等緊急通知。
 */
async function sendDirect(message) {
  const results = [];
  if (line.isEnabled()) {
    try {
      results.push(await line.send(message));
    } catch (err) {
      log.error('notifier', 'LINE 發送失敗 (direct)', err.message);
    }
  }
  if (telegram.isEnabled()) {
    try {
      results.push(await telegram.send(message));
    } catch (err) {
      log.error('notifier', 'Telegram 發送失敗 (direct)', err.message);
    }
  }
  return results;
}

function getChannelStatus() {
  return {
    line: line.isEnabled(),
    telegram: telegram.isEnabled(),
  };
}

module.exports = { notifyForSiteResult, sendDirect, getChannelStatus };

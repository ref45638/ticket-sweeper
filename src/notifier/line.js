const config = require('../config/env');

function isEnabled() {
  return config.line.enabled();
}

async function send(text) {
  if (!isEnabled()) return { skipped: true, channel: 'line' };

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.line.token}`,
    },
    body: JSON.stringify({
      to: config.line.targetId,
      messages: [{ type: 'text', text }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE push failed (${res.status}): ${body}`);
  }

  return { ok: true, channel: 'line' };
}

module.exports = { isEnabled, send };

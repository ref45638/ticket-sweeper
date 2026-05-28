const state = require('../state');
const config = require('../config/env');

function shouldNotify(siteId, sectionName) {
  return state.shouldNotify(siteId, sectionName, config.notifyCooldownMs);
}

function markNotified(siteId, sectionName) {
  state.markNotified(siteId, sectionName, config.notifyCooldownMs);
}

module.exports = { shouldNotify, markNotified };

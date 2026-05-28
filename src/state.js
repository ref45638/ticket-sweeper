const resultsBySiteId = new Map();
const cooldownUntil = new Map();

let schedulerMeta = {
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
};

function setSiteResult(siteId, payload) {
  resultsBySiteId.set(siteId, {
    ...payload,
    updatedAt: new Date().toISOString(),
  });
}

function getSiteResult(siteId) {
  return resultsBySiteId.get(siteId) ?? null;
}

function getAllResults() {
  return Array.from(resultsBySiteId.entries()).map(([siteId, data]) => ({
    siteId,
    ...data,
  }));
}

function setSchedulerMeta(patch) {
  schedulerMeta = { ...schedulerMeta, ...patch };
}

function getSchedulerMeta() {
  return { ...schedulerMeta };
}

function cooldownKey(siteId, sectionName) {
  return `${siteId}:${sectionName}`;
}

function getCooldownRemaining(siteId, sectionName) {
  const key = cooldownKey(siteId, sectionName);
  const until = cooldownUntil.get(key);
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

function markNotified(siteId, sectionName, cooldownMs) {
  const key = cooldownKey(siteId, sectionName);
  cooldownUntil.set(key, Date.now() + cooldownMs);
}

function shouldNotify(siteId, sectionName, cooldownMs) {
  return getCooldownRemaining(siteId, sectionName) === 0;
}

module.exports = {
  setSiteResult,
  getSiteResult,
  getAllResults,
  setSchedulerMeta,
  getSchedulerMeta,
  markNotified,
  shouldNotify,
};

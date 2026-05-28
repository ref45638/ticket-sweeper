const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SITES_PATH = path.join(__dirname, '../sites.json');

async function readSitesFile() {
  const raw = await fs.readFile(SITES_PATH, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

async function writeSitesFile(sites) {
  await fs.writeFile(SITES_PATH, JSON.stringify(sites, null, 2) + '\n', 'utf8');
}

async function listSites() {
  return readSitesFile();
}

async function getSiteById(id) {
  const sites = await readSitesFile();
  return sites.find((s) => s.id === id) ?? null;
}

async function createSite({ label, url, scraperId = 'tixcraft', enabled = true }) {
  if (!label?.trim() || !url?.trim()) {
    throw new Error('label and url are required');
  }
  const sites = await readSitesFile();
  const site = {
    id: crypto.randomUUID(),
    label: label.trim(),
    url: url.trim(),
    scraperId: scraperId || 'tixcraft',
    enabled: Boolean(enabled),
    createdAt: new Date().toISOString(),
  };
  sites.push(site);
  await writeSitesFile(sites);
  return site;
}

async function updateSite(id, patch) {
  const sites = await readSitesFile();
  const idx = sites.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  const current = sites[idx];
  if (patch.label !== undefined) current.label = String(patch.label).trim();
  if (patch.url !== undefined) current.url = String(patch.url).trim();
  if (patch.scraperId !== undefined) current.scraperId = patch.scraperId;
  if (patch.enabled !== undefined) current.enabled = Boolean(patch.enabled);

  sites[idx] = current;
  await writeSitesFile(sites);
  return current;
}

async function deleteSite(id) {
  const sites = await readSitesFile();
  const next = sites.filter((s) => s.id !== id);
  if (next.length === sites.length) return false;
  await writeSitesFile(next);
  return true;
}

async function listEnabledSites() {
  const sites = await readSitesFile();
  return sites.filter((s) => s.enabled);
}

module.exports = {
  listSites,
  getSiteById,
  createSite,
  updateSite,
  deleteSite,
  listEnabledSites,
};

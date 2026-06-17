const express = require('express');
const sitesStore = require('../config/sites');
const state = require('../state');
const scheduler = require('../scheduler');
const { isBrowserAlive } = require('../scrapers/browser');
const notifier = require('../notifier');
const { listScraperIds } = require('../scrapers');
const settings = require('../config/settings');
const log = require('../logger');

const router = express.Router();

router.get('/status', async (_req, res) => {
  const meta = state.getSchedulerMeta();
  const sites = await sitesStore.listSites();
  const enabledCount = sites.filter((s) => s.enabled).length;

  const nextRunMs = meta.nextRunAt ? new Date(meta.nextRunAt).getTime() - Date.now() : null;

  res.json({
    schedulerRunning: meta.running || scheduler.isScrapeInProgress(),
    lastRunAt: meta.lastRunAt,
    nextRunAt: meta.nextRunAt,
    nextRunInSeconds: nextRunMs != null ? Math.max(0, Math.ceil(nextRunMs / 1000)) : null,
    scrapeIntervalMs: meta.scrapeIntervalMs ?? null,
    scheduleMode: meta.scheduleMode ?? 'interval',
    lastError: meta.lastError,
    browserAlive: await isBrowserAlive(),
    sitesCount: sites.length,
    enabledSitesCount: enabledCount,
    notifications: notifier.getChannelStatus(),
    scrapers: listScraperIds(),
  });
});

var lastNotified = null;
const SECTION_COOLDOWN_BUFFER_MS = 60 * 1000; // 1 minute
router.get('/results', async (req, res) => {
  const NOW = Date.now();

  // 如果上次通知時間距離現在超過 SECTION_COOLDOWN_BUFFER_MS，則允許通知，並重新設置 lastNotified
  if (NOW - lastNotified >= SECTION_COOLDOWN_BUFFER_MS) {
    lastNotified = NOW;

    const ip =
      (req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : '') ||
      req.ip ||
      req.socket?.remoteAddress ||
      '';
    const ua = req.headers['user-agent'] || '';

    res.on('finish', () => {
      log.info('api', 'access', {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        ip,
        ua,
        query: req.query || {},
      });
    });
  }

  const sites = await sitesStore.listSites();
  const stored = state.getAllResults();
  const byId = new Map(stored.map((r) => [r.siteId, r]));

  const payload = sites
    .filter((site) => site.enabled)
    .map((site) => {
      const data = byId.get(site.id);
      return {
        id: site.id,
        label: site.label,
        url: site.url,
        enabled: site.enabled,
        scraperId: site.scraperId,
        lastScrapedAt: data?.lastScrapedAt ?? null,
        error: data?.error ?? null,
        sections: data?.sections ?? [],
        summary: data?.summary ?? { availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
      };
    });

  res.json({
    updatedAt: new Date().toISOString(),
    sites: payload,
  });
});

router.get('/sites', async (_req, res) => {
  const sites = await sitesStore.listSites();
  const results = state.getAllResults();
  const byId = new Map(results.map((r) => [r.siteId, r]));

  res.json(
    sites.map((site) => ({
      ...site,
      lastScrapedAt: byId.get(site.id)?.lastScrapedAt ?? null,
      lastError: byId.get(site.id)?.error ?? null,
    }))
  );
});

router.post('/sites', async (req, res) => {
  try {
    const site = await sitesStore.createSite(req.body);
    res.status(201).json(site);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/sites/:id', async (req, res) => {
  const site = await sitesStore.updateSite(req.params.id, req.body);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  res.json(site);
});

router.delete('/sites/:id', async (req, res) => {
  const ok = await sitesStore.deleteSite(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Site not found' });
  res.status(204).end();
});

router.post('/sites/:id/scrape', async (req, res) => {
  try {
    const outcome = await scheduler.scrapeSiteById(req.params.id);
    if (outcome.error && !outcome.ok) {
      return res.status(500).json(outcome);
    }
    const data = state.getSiteResult(req.params.id);
    res.json({ ...outcome, result: data });
  } catch (err) {
    if (err.message === 'Site not found') {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/settings', async (_req, res) => {
  const data = await settings.getSettings();
  res.json({
    tixuisid: data.tixuisid || '',
    hasTixuisid: Boolean(data.tixuisid),
    ticketQuantity: data.ticketQuantity || 1,
    notifyEvents: data.notifyEvents || {},
    fetchCaptchaImage: data.fetchCaptchaImage !== false,
    unattendedMode: Boolean(data.unattendedMode),
  });
});

router.patch('/settings', async (req, res) => {
  const data = await settings.patchSettings(req.body);
  res.json({
    tixuisid: data.tixuisid || '',
    hasTixuisid: Boolean(data.tixuisid),
    ticketQuantity: data.ticketQuantity || 1,
    notifyEvents: data.notifyEvents || {},
    fetchCaptchaImage: data.fetchCaptchaImage !== false,
    unattendedMode: Boolean(data.unattendedMode),
  });
});

// ===== Browser Control =====
const { setAllBrowsersVisibility } = require('../scrapers/browser');

router.post('/browser/visibility', async (req, res) => {
  const { visible } = req.body;
  try {
    await setAllBrowsersVisibility(Boolean(visible));
    res.json({ success: true, visible: Boolean(visible) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== OCR Proxy =====
const OCR_BASE = 'http://127.0.0.1:8000';

router.get('/ocr/health', async (_req, res) => {
  try {
    const r = await fetch(`${OCR_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    res.json(data);
  } catch {
    res.json({ status: 'unreachable', model_loaded: false });
  }
});

router.post('/ocr', async (req, res) => {
  const { image_base64 } = req.body;
  if (!image_base64) return res.status(400).json({ success: false, error: 'Missing image_base64' });
  try {
    const r = await fetch(`${OCR_BASE}/ocr/base64`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64 }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ success: false, error: `OCR Server 無法連線: ${err.message}` });
  }
});

// ===== Logs & Stats =====
const logger = require('../logger');

router.get('/stats', (_req, res) => {
  res.json(state.getStats());
});

router.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // flush existing history
  for (const entry of logger.history()) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const listener = (entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  };
  logger.emitter.on('log', listener);

  req.on('close', () => {
    logger.emitter.off('log', listener);
  });
});

module.exports = router;

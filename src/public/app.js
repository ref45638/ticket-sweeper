const api = {
  async getStatus() {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Failed to load status');
    return res.json();
  },
  async getSites() {
    const res = await fetch('/api/sites');
    if (!res.ok) throw new Error('Failed to load sites');
    return res.json();
  },
  async getResults() {
    const res = await fetch('/api/results');
    if (!res.ok) throw new Error('Failed to load results');
    return res.json();
  },
  async createSite(body) {
    const res = await fetch('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Create failed');
    return data;
  },
  async patchSite(id, body) {
    const res = await fetch(`/api/sites/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    return data;
  },
  async deleteSite(id) {
    const res = await fetch(`/api/sites/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Delete failed');
    }
  },
  async scrapeNow(id) {
    const res = await fetch(`/api/sites/${id}/scrape`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.error || 'Scrape failed');
    return data;
  },
};

const $ = (sel) => document.querySelector(sel);

function toast(message) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function formatTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-TW', { hour12: false });
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const render = {
  statusStrip(status) {
    $('#last-run').textContent = formatTime(status.lastRunAt);
    $('#next-run').textContent = formatTime(status.nextRunAt);
    $('#sites-count').textContent = `${status.enabledSitesCount} / ${status.sitesCount}`;

    const pill = $('#status-pill');
    if (status.schedulerRunning) {
      pill.textContent = 'RUNNING';
      pill.className = 'status-pill status-pill--running';
    } else if (status.lastError) {
      pill.textContent = 'ERROR';
      pill.className = 'status-pill status-pill--error';
    } else {
      pill.textContent = 'IDLE';
      pill.className = 'status-pill status-pill--idle';
    }

    const browserDot = $('#browser-dot');
    const browserText = $('#browser-text');
    if (status.browserAlive) {
      browserDot.className = 'dot dot--ok';
      browserText.textContent = 'OK';
    } else {
      browserDot.className = 'dot dot--bad';
      browserText.textContent = 'DOWN';
    }

    const lineBadge = $('#badge-line');
    lineBadge.textContent = status.notifications?.line ? 'LINE ON' : 'LINE OFF';
    lineBadge.className = `badge ${status.notifications?.line ? 'badge--on' : 'badge--off'}`;

    const tgBadge = $('#badge-telegram');
    tgBadge.textContent = status.notifications?.telegram ? 'TG ON' : 'TG OFF';
    tgBadge.className = `badge ${status.notifications?.telegram ? 'badge--on' : 'badge--off'}`;
  },

  sitesTable(sites) {
    const tbody = $('#sites-tbody');
    if (!sites.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">尚無監控站點，點「＋ 新增」</td></tr>';
      return;
    }

    tbody.innerHTML = sites
      .map(
        (site) => `
      <tr data-id="${escapeHtml(site.id)}" class="${site.enabled ? '' : 'row-disabled'}">
        <td>
          <input type="checkbox" class="toggle site-toggle" data-id="${escapeHtml(site.id)}"
            ${site.enabled ? 'checked' : ''} aria-label="啟用 ${escapeHtml(site.label)}" />
        </td>
        <td>${escapeHtml(site.label)}</td>
        <td class="url-cell" title="${escapeHtml(site.url)}">${escapeHtml(site.url)}</td>
        <td class="mono">${formatTime(site.lastScrapedAt)}</td>
        <td class="actions-cell">
          <button type="button" class="btn btn--ghost btn--sm btn-scrape" data-id="${escapeHtml(site.id)}">立即抓</button>
          <button type="button" class="btn btn--ghost btn--sm btn--danger btn-delete" data-id="${escapeHtml(site.id)}">刪除</button>
        </td>
      </tr>`
      )
      .join('');
  },

  resultsPanel(data) {
    const panel = $('#results-panel');
    $('#results-updated').textContent = data.updatedAt ? formatTime(data.updatedAt) : '—';

    if (!data.sites?.length) {
      panel.innerHTML = `
        <div class="empty-radar">
          <svg class="radar-svg" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="48" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
          </svg>
          <p>尚未加入監控 URL</p>
        </div>`;
      return;
    }

    panel.innerHTML = data.sites
      .map((site) => {
        const sections = site.sections || [];
        const available = sections.filter((s) => s.status === 'available');
        const soldOut = sections.filter((s) => s.status === 'soldOut');
        const ignored = sections.filter((s) => s.status === 'ignored');

        const sectionHtml = (list, rowClass, tag) =>
          list
            .map((s) => {
              const live = s.status === 'available';
              return `
              <li class="section-row ${rowClass} ${live ? 'section-row--live' : ''}">
                <span>${escapeHtml(s.name)}${s.id ? ` <span class="mono" style="opacity:0.6">#${escapeHtml(s.id)}</span>` : ''}</span>
                <span>
                  ${live ? `<span class="section-remaining">${s.remaining != null && s.remaining > 0 ? `剩餘 ${s.remaining}` : s.hotSelling ? '熱賣中' : '可購買'}</span> <span class="tag tag--live">LIVE</span>` : `<span class="tag ${tag}">${s.status === 'ignored' ? 'IGNORED' : 'SOLD OUT'}</span>`}
                </span>
              </li>`;
            })
            .join('');

        let body = '';
        if (site.error) {
          body += `<div class="site-result__error">${escapeHtml(site.error)}</div>`;
        }

        if (available.length || soldOut.length) {
          body += `<ul class="section-list">${sectionHtml(available, '', 'tag--live')}${sectionHtml(soldOut, 'section-row--sold', 'tag--sold')}</ul>`;
        } else if (!site.error && !ignored.length) {
          body += `<p style="padding:12px;color:var(--text-secondary)">目前無可購區域</p>`;
        }

        if (ignored.length) {
          const uid = `ignored-${site.id}`;
          body += `
            <div class="ignored-block">
              <button type="button" class="ignored-toggle" data-target="${uid}" aria-expanded="false">
                ▸ 已略過 ${ignored.length} 區（輪椅/身障）
              </button>
              <ul class="section-list ignored-list hidden" id="${uid}">
                ${sectionHtml(ignored, 'section-row--ignored', 'tag--ignored')}
              </ul>
            </div>`;
        }

        return `
          <article class="site-result">
            <div class="site-result__head">
              <h3 class="site-result__title">${escapeHtml(site.label)}</h3>
              <a class="site-result__link" href="${escapeHtml(site.url)}" target="_blank" rel="noopener">開啟購票 ↗</a>
            </div>
            ${body}
          </article>`;
      })
      .join('');

    panel.querySelectorAll('.ignored-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.dataset.target);
        const hidden = target.classList.toggle('hidden');
        btn.setAttribute('aria-expanded', String(!hidden));
        btn.textContent = btn.textContent.replace(/^[▸▾]/, hidden ? '▸' : '▾');
      });
    });
  },
};

let pollTimer = null;
let statusTimer = null;

async function refreshStatus() {
  try {
    const status = await api.getStatus();
    render.statusStrip(status);
    const select = $('#scraper-select');
    if (status.scrapers?.length && select.options.length <= 1) {
      select.innerHTML = status.scrapers
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`)
        .join('');
    }
  } catch (err) {
    toast(err.message);
  }
}

async function refreshSites() {
  try {
    const sites = await api.getSites();
    render.sitesTable(sites);
  } catch (err) {
    toast(err.message);
  }
}

async function refreshResults() {
  try {
    const data = await api.getResults();
    render.resultsPanel(data);
  } catch (err) {
    toast(err.message);
  }
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshSites(), refreshResults()]);
}

function bindFormSubmit() {
  const form = $('#add-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api.createSite({
        label: fd.get('label'),
        url: fd.get('url'),
        scraperId: fd.get('scraperId'),
        enabled: fd.get('enabled') === 'on',
      });
      form.reset();
      form.querySelector('[name="enabled"]').checked = true;
      form.classList.add('hidden');
      await refreshAll();
    } catch (err) {
      toast(err.message);
    }
  });
}

function bindTableActions() {
  const tbody = $('#sites-tbody');
  tbody.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('site-toggle')) return;
    const id = e.target.dataset.id;
    try {
      await api.patchSite(id, { enabled: e.target.checked });
      await refreshSites();
    } catch (err) {
      toast(err.message);
      e.target.checked = !e.target.checked;
    }
  });

  tbody.addEventListener('click', async (e) => {
    const scrapeBtn = e.target.closest('.btn-scrape');
    if (scrapeBtn) {
      scrapeBtn.classList.add('loading');
      try {
        await api.scrapeNow(scrapeBtn.dataset.id);
        await refreshAll();
      } catch (err) {
        toast(err.message);
      } finally {
        scrapeBtn.classList.remove('loading');
      }
      return;
    }

    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn) {
      if (!confirm('確定刪除此監控？')) return;
      try {
        await api.deleteSite(deleteBtn.dataset.id);
        await refreshAll();
      } catch (err) {
        toast(err.message);
      }
    }
  });
}

function bindChrome() {
  $('#btn-toggle-form').addEventListener('click', () => {
    $('#add-form').classList.toggle('hidden');
  });
  $('#btn-cancel-form').addEventListener('click', () => {
    $('#add-form').classList.add('hidden');
  });
  $('#btn-refresh-all').addEventListener('click', () => refreshAll());
}

const poll = {
  start() {
    pollTimer = setInterval(async () => {
      await refreshResults();
      await refreshSites();
    }, 15_000);
    statusTimer = setInterval(refreshStatus, 5_000);
  },
  stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (statusTimer) clearInterval(statusTimer);
  },
};

async function init() {
  bindFormSubmit();
  bindTableActions();
  bindChrome();
  await refreshAll();
  poll.start();
}

init();

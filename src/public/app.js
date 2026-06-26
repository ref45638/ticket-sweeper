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
  async getSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error('Failed to load settings');
    return res.json();
  },
  async patchSettings(body) {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    return data;
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
  async toggleBrowserVisibility(visible) {
    const res = await fetch('/api/browser/visibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visible })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to toggle visibility');
    return data;
  },
  async ocrHealth() {
    const res = await fetch('/api/ocr/health');
    return res.json();
  },
  async ocrRecognize(imageBase64) {
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: imageBase64 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'OCR failed');
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

// ===== TAB 切換 =====

function initTabs() {
  const btns = document.querySelectorAll('.tab-btn:not(.tab-btn--disabled)');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      // 切換按鈕 active
      document.querySelectorAll('.tab-btn').forEach((b) => {
        b.classList.remove('tab-btn--active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('tab-btn--active');
      btn.setAttribute('aria-selected', 'true');
      // 切換面板
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.hidden = true;
        p.classList.remove('tab-panel--active');
      });
      const panel = document.getElementById(`tab-${tabId}`);
      if (panel) {
        panel.hidden = false;
        panel.classList.add('tab-panel--active');
      }
      // 切到 OCR tab 時檢查健康狀態
      if (tabId === 'ocr') checkOcrHealth();
      // 切到設定 tab 時更新 OCR 狀態
      if (tabId === 'settings') checkOcrHealthForSettings();
    });
  });
}

// ===== 原有 render =====

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

    const select = $('#scraper-select');
    if (status.scrapers?.length && select.options.length <= 1) {
      select.innerHTML = status.scrapers
        .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`)
        .join('');
    }
  },

  cookieStrip(settings) {
    const status = $('#cookie-status');
    const input = $('#cookie-input');
    const dot = $('#cookie-mode-dot');
    const text = $('#cookie-mode-text');
    const icon = $('#cookie-icon');
    const strip = $('#cookie-strip');

    if (settings.hasTixuisid) {
      // 顯示遮罩值
      const masked = settings.tixuisid.length > 8
        ? settings.tixuisid.slice(0, 4) + '••••' + settings.tixuisid.slice(-4)
        : '••••••••';
      status.textContent = masked;
      input.value = settings.tixuisid;
      dot.className = 'dot dot--ok';
      text.textContent = '自動加車模式';
      icon.classList.add('settings-icon--active');
    } else {
      status.textContent = '未設定';
      input.value = '';
      dot.className = 'dot dot--unknown';
      text.textContent = '僅監控';
      icon.classList.remove('settings-icon--active');
    }

    // 同步票數
    const qtyInput = $('#qty-input');
    qtyInput.value = settings.ticketQuantity || 1;

    // 同步推播事件設定
    const notifyEvents = settings.notifyEvents || {};
    const notifyFound = $('#notify-ticketFound');
    const notifyCaptcha = $('#notify-cartManualCaptcha');
    const notifySuccess = $('#notify-cartSuccess');
    const notifyFailure = $('#notify-cartFailure');
    const notifyError = $('#notify-scraperError');

    if (notifyFound) notifyFound.checked = notifyEvents.ticketFound !== false;
    if (notifyCaptcha) notifyCaptcha.checked = notifyEvents.cartManualCaptcha !== false;
    if (notifySuccess) notifySuccess.checked = notifyEvents.cartSuccess !== false;
    if (notifyFailure) notifyFailure.checked = notifyEvents.cartFailure === true;
    if (notifyError) notifyError.checked = notifyEvents.scraperError !== false;

    // 同步功能設定
    const fetchCaptchaImageToggle = $('#setting-fetchCaptchaImage');
    if (fetchCaptchaImageToggle) fetchCaptchaImageToggle.checked = settings.fetchCaptchaImage !== false;

    const unattendedModeToggle = $('#setting-unattendedMode');
    if (unattendedModeToggle) unattendedModeToggle.checked = Boolean(settings.unattendedMode);

    const warmKillerToggle = $('#setting-warmKiller');
    if (warmKillerToggle) warmKillerToggle.checked = Boolean(settings.warmKiller);
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
  } catch (err) {
    toast(err.message);
  }
}

async function refreshSettings() {
  try {
    const data = await api.getSettings();
    render.cookieStrip(data);
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
  await Promise.all([refreshStatus(), refreshSettings(), refreshSites(), refreshResults()]);
}

function bindCookieStrip() {
  const input = $('#cookie-input');
  const qtyInput = $('#qty-input');
  const saveBtn = $('#btn-save-cookie');
  const clearBtn = $('#btn-clear-cookie');

  saveBtn.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) {
      toast('請輸入 TIXUISID Cookie 值');
      input.focus();
      return;
    }
    const qty = parseInt(qtyInput.value, 10) || 1;
    try {
      await api.patchSettings({ tixuisid: value, ticketQuantity: qty });
      toast(`已啟用自動加車模式（${qty} 張）`);
      await refreshSettings();
    } catch (err) {
      toast(err.message);
    }
  });

  // 票數變更時自動儲存
  qtyInput.addEventListener('change', async () => {
    const qty = parseInt(qtyInput.value, 10) || 1;
    try {
      await api.patchSettings({ ticketQuantity: qty });
      toast(`票數已更新為 ${qty} 張`);
    } catch (err) {
      toast(err.message);
    }
  });

  clearBtn.addEventListener('click', async () => {
    try {
      await api.patchSettings({ tixuisid: '' });
      toast('已清除 Cookie，恢復僅監控模式');
      input.value = '';
      await refreshSettings();
    } catch (err) {
      toast(err.message);
    }
  });

  // Enter 鍵直接儲存
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
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

  const toggleBrowserBtn = $('#btn-toggle-browser');
  if (toggleBrowserBtn) {
    toggleBrowserBtn.addEventListener('click', async () => {
      const isVisible = toggleBrowserBtn.dataset.visible === 'true';
      const targetVisible = !isVisible;
      try {
        await api.toggleBrowserVisibility(targetVisible);
        toggleBrowserBtn.dataset.visible = String(targetVisible);
        toggleBrowserBtn.textContent = targetVisible ? '隱藏視窗' : '顯示視窗';
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

const poll = {
  start() {
    pollTimer = setInterval(async () => {
      await refreshResults();
      await refreshSites();
    }, 15_000);
    statusTimer = setInterval(() => {
      refreshStatus();
      refreshSettings();
    }, 5_000);
  },
  stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (statusTimer) clearInterval(statusTimer);
  },
};

function bindNotifyToggles() {
  const toggles = [
    { id: 'notify-ticketFound', key: 'ticketFound' },
    { id: 'notify-cartManualCaptcha', key: 'cartManualCaptcha' },
    { id: 'notify-cartSuccess', key: 'cartSuccess' },
    { id: 'notify-cartFailure', key: 'cartFailure' },
    { id: 'notify-scraperError', key: 'scraperError' },
  ];

  toggles.forEach(({ id, key }) => {
    const el = $('#' + id);
    if (el) {
      el.addEventListener('change', async () => {
        try {
          const payload = { notifyEvents: { [key]: el.checked } };
          await api.patchSettings(payload);
          toast('推播設定已更新');
        } catch (err) {
          toast(err.message);
          el.checked = !el.checked; // 發生錯誤時回復原狀
        }
      });
    }
  });

  const fetchCaptchaImageToggle = $('#setting-fetchCaptchaImage');
  if (fetchCaptchaImageToggle) {
    fetchCaptchaImageToggle.addEventListener('change', async () => {
      try {
        await api.patchSettings({ fetchCaptchaImage: fetchCaptchaImageToggle.checked });
        toast('功能設定已更新');
      } catch (err) {
        toast(err.message);
        fetchCaptchaImageToggle.checked = !fetchCaptchaImageToggle.checked;
      }
    });
  }

  const unattendedModeToggle = $('#setting-unattendedMode');
  if (unattendedModeToggle) {
    unattendedModeToggle.addEventListener('change', async () => {
      try {
        await api.patchSettings({ unattendedMode: unattendedModeToggle.checked });
        toast(unattendedModeToggle.checked ? '已開啟離座模式' : '已關閉離座模式');
      } catch (err) {
        toast(err.message);
        unattendedModeToggle.checked = !unattendedModeToggle.checked;
      }
    });
  }

  const warmKillerToggle = $('#setting-warmKiller');
  if (warmKillerToggle) {
    warmKillerToggle.addEventListener('change', async () => {
      try {
        await api.patchSettings({ warmKiller: warmKillerToggle.checked });
        toast(warmKillerToggle.checked ? '已開啟 Killer 保溫' : '已關閉 Killer 保溫');
      } catch (err) {
        toast(err.message);
        warmKillerToggle.checked = !warmKillerToggle.checked;
      }
    });
  }
}

// ===== OCR 驗證器 =====

const ocrHistory = [];

async function checkOcrHealth() {
  const dot = $('#ocr-health-dot');
  const text = $('#ocr-health-text');
  try {
    const data = await api.ocrHealth();
    if (data.status === 'ok' && data.model_loaded) {
      dot.className = 'dot dot--ok';
      text.textContent = 'OCR Server 已連線';
    } else if (data.status === 'ok') {
      dot.className = 'dot dot--bad';
      text.textContent = '模型未載入';
    } else {
      dot.className = 'dot dot--bad';
      text.textContent = 'OCR Server 無法連線';
    }
  } catch {
    dot.className = 'dot dot--bad';
    text.textContent = 'OCR Server 無法連線';
  }
}

async function checkOcrHealthForSettings() {
  const dot = $('#ocr-settings-dot');
  const text = $('#ocr-settings-text');
  const status = $('#ocr-settings-status');
  try {
    const data = await api.ocrHealth();
    if (data.status === 'ok' && data.model_loaded) {
      dot.className = 'dot dot--ok';
      text.textContent = '已連線';
      status.textContent = 'http://127.0.0.1:8000';
    } else if (data.status === 'ok') {
      dot.className = 'dot dot--bad';
      text.textContent = '模型未載入';
      status.textContent = '伺服器在線但模型未就緒';
    } else {
      dot.className = 'dot dot--bad';
      text.textContent = '離線';
      status.textContent = '無法連線至 OCR Server';
    }
  } catch {
    dot.className = 'dot dot--bad';
    text.textContent = '離線';
    status.textContent = '無法連線至 OCR Server';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showPreview(dataUrl) {
  const preview = $('#ocr-preview');
  const img = $('#ocr-preview-img');
  img.src = dataUrl;
  preview.classList.remove('hidden');
  $('#ocr-result').classList.add('hidden');
}

function clearOcr() {
  $('#ocr-preview').classList.add('hidden');
  $('#ocr-result').classList.add('hidden');
  $('#ocr-preview-img').src = '';
}

function renderOcrHistory() {
  const list = $('#ocr-history-list');
  if (!ocrHistory.length) {
    list.innerHTML = '<div class="ocr-history-empty"><p>尚無辨識紀錄</p></div>';
    return;
  }
  list.innerHTML = ocrHistory
    .map(
      (item) => `
    <div class="ocr-history-item">
      <img class="ocr-history-item__img" src="${item.imgSrc}" alt="驗證碼" />
      <div class="ocr-history-item__info">
        <span class="ocr-history-item__text">${escapeHtml(item.text)}</span>
        <span class="ocr-history-item__time mono">${item.time} · ${item.ms}ms</span>
      </div>
    </div>`
    )
    .join('');
}

async function handleOcrFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('請上傳圖片檔案');
    return;
  }
  const dataUrl = await fileToBase64(file);
  showPreview(dataUrl);
}

async function doOcrRecognize() {
  const img = $('#ocr-preview-img');
  const resultEl = $('#ocr-result');
  const resultText = $('#ocr-result-text');
  const resultMeta = $('#ocr-result-meta');
  const btn = $('#ocr-recognize-btn');

  if (!img.src) return;

  btn.classList.add('loading');
  const startTime = performance.now();

  try {
    const data = await api.ocrRecognize(img.src);
    const elapsed = Math.round(performance.now() - startTime);

    if (data.success) {
      resultText.textContent = data.text;
      resultMeta.textContent = `耗時 ${elapsed}ms`;
      resultEl.classList.remove('hidden');

      // 加入歷史
      ocrHistory.unshift({
        imgSrc: img.src,
        text: data.text,
        time: new Date().toLocaleTimeString('zh-TW', { hour12: false }),
        ms: elapsed,
      });
      if (ocrHistory.length > 50) ocrHistory.pop();
      renderOcrHistory();
    } else {
      toast(`辨識失敗: ${data.error}`);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.classList.remove('loading');
  }
}

function bindOcr() {
  const dropzone = $('#ocr-dropzone');
  const fileInput = $('#ocr-file-input');

  // 檔案選擇
  fileInput.addEventListener('change', (e) => {
    if (e.target.files?.[0]) handleOcrFile(e.target.files[0]);
  });

  // 拖放
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('ocr-dropzone--dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('ocr-dropzone--dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('ocr-dropzone--dragover');
    if (e.dataTransfer.files?.[0]) handleOcrFile(e.dataTransfer.files[0]);
  });

  // 剪貼簿貼上 (全域)
  document.addEventListener('paste', (e) => {
    // 只在 OCR tab 可見時處理
    const ocrTab = $('#tab-ocr');
    if (ocrTab.hidden) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        handleOcrFile(item.getAsFile());
        return;
      }
    }
  });

  // 辨識按鈕
  $('#ocr-recognize-btn').addEventListener('click', doOcrRecognize);

  // 清除按鈕
  $('#ocr-clear-btn').addEventListener('click', clearOcr);

  // 複製結果
  $('#ocr-copy-btn').addEventListener('click', () => {
    const text = $('#ocr-result-text').textContent;
    navigator.clipboard.writeText(text).then(() => toast('已複製到剪貼簿'));
  });

  // 清除歷史
  $('#ocr-clear-history').addEventListener('click', () => {
    ocrHistory.length = 0;
    renderOcrHistory();
  });
}

// ===== Logs & Stats =====

function bindLogs() {
  const container = $('#logs-container');
  const autoscroll = $('#logs-autoscroll');
  
  $('#logs-clear-btn').addEventListener('click', () => {
    container.innerHTML = '';
  });

  const evtSource = new EventSource('/api/logs/stream');
  
  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      const div = document.createElement('div');
      div.className = 'log-entry';
      
      let timeStr = data.time;
      if (data.time) {
        const d = new Date(data.time);
        if (!isNaN(d)) {
          timeStr = d.toLocaleTimeString('zh-TW', { hour12: false });
        }
      }

      div.innerHTML = `
        <span class="log-time">[${timeStr}]</span>
        <span class="log-level log-level--${data.level}">[${data.level}]</span>
        <span class="log-tag">[${data.tag}]</span>
        <span class="log-msg">${data.message}</span>
      `;
      container.appendChild(div);
      
      if (autoscroll.checked) {
        container.scrollTop = container.scrollHeight;
      }
    } catch(err) {
      // ignore parse errors
    }
  };
}

async function refreshStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    
    // format uptime
    const sec = Math.floor(data.uptimeMs / 1000);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    
    $('#stat-uptime').textContent = `${h}:${m}:${s}`;
    $('#stat-scrapes-total').textContent = data.scrapesTotal.toLocaleString();
    $('#stat-scrapes-success').textContent = data.scrapesSuccess.toLocaleString();
    $('#stat-scrapes-error').textContent = data.scrapesError.toLocaleString();
    $('#stat-captcha-events').textContent = data.captchaEvents.toLocaleString();
    $('#stat-cart-success').textContent = data.cartSuccess.toLocaleString();
    
  } catch (err) {
    console.error('Failed to fetch stats', err);
  }
}

// ===== Init =====

async function init() {
  initTabs();
  bindCookieStrip();
  bindNotifyToggles();
  bindFormSubmit();
  bindTableActions();
  bindChrome();
  bindOcr();
  bindLogs();
  
  await refreshAll();
  await refreshStats();
  
  poll.start();
  // Poll stats every 5s along with status
  setInterval(refreshStats, 5000);
}

init();

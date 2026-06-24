const fs = require('fs');
const path = require('path');
const { withPage, simulateHumanBehavior, resetBrowser } = require('./browser');
const log = require('../logger');
const notifier = require('../notifier');
const settings = require('../config/settings');
const sitesStore = require('../config/sites');

const activeCartTasks = new Set();

const OCR_BASE64_URL = 'http://127.0.0.1:8000/ocr/base64';

// 驗證碼選擇器（主搶票、重試兩條路徑共用，避免各自寫不同字串造成漂移）。
// tixcraft 實際的驗證碼 img id 為 TicketForm_verifyCode-image；保留 imageRandom 與通用 fallback 以防改版。
const CAPTCHA_IMG_SELECTOR = '#TicketForm_verifyCode-image, #TicketForm_imageRandom, img[src*="captcha"], img[id*="captcha"]';
const CAPTCHA_INPUT_SELECTOR = '#TicketForm_verifyCode, input[name*="verify"], input[name*="captcha"]';

/**
 * 在瀏覽器 context 內判斷目前頁面是否為 WAF / Cloudflare 阻擋（挑戰）頁。
 * 注意：此函式會被序列化後丟進 page.evaluate 執行，請勿引用任何外部變數。
 * @returns {string|null} 命中的阻擋類型字串；未阻擋時回傳 null
 */
function detectBlockPage() {
  if (
    document.querySelector(
      '#challenge-running, #challenge-form, .cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[title*="Cloudflare"]'
    )
  ) {
    return 'cloudflare-challenge';
  }
  const haystack = ((document.title || '') + ' ' + (document.body ? document.body.innerText : '')).toLowerCase();
  if (/just a moment|checking your browser|attention required|enable javascript and cookies|verifying you are human/.test(haystack)) {
    return 'cloudflare-interstitial';
  }
  if (/access denied|error 1020|403 forbidden/.test(haystack)) {
    return 'access-denied';
  }
  return null;
}

/**
 * 在瀏覽器 context 內解析 tixcraft 區域列表（Scout 與 Killer 共用同一套「可購/售完/熱賣」判斷）。
 * 注意：此函式會被序列化後丟進 page.evaluate 執行，請勿引用任何外部變數。
 *
 * @param {{ markRandomAvailable?: boolean }} [opts]
 *   markRandomAvailable=true 時，會在「可購且非輪椅/身障」的區域中隨機挑一個，
 *   於其連結標上 data-killer-target，供呼叫端後續點擊。
 * @returns {{ sections: Array, chosen: ({ name: string } | null) }}
 */
function parseAreaList({ markRandomAvailable = false } = {}) {
  const NAV_BLOCKLIST = /^(Events|My Tickets|Sign In|Menu|Home|Clear|Search)/i;
  const stripName = (text) =>
    text
      .replace(/剩餘\s*\d+/g, '')
      .replace(/\d+\s*seat\(s\)\s*remaining/gi, '')
      .replace(/熱賣中|熱銷中/gi, '')
      .replace(/已售完/gi, '')
      .replace(/Sold\s*out/gi, '')
      .trim();

  const listRoots = document.querySelectorAll('ul.area-list, .zone.area-list');
  const lis = listRoots.length > 0 ? Array.from(listRoots).flatMap((root) => [...root.querySelectorAll('li')]) : [...document.querySelectorAll('li')];

  if (markRandomAvailable) {
    // 清除上一輪可能殘留的標記，避免選擇器抓到舊節點
    document.querySelectorAll('a[data-killer-target]').forEach((a) => a.removeAttribute('data-killer-target'));
  }

  const sections = [];
  const candidates = []; // 可購且非輪椅/身障，供 Killer 隨機挑選
  const seen = new Set();

  for (const li of lis) {
    const anchor = li.querySelector('a');
    const font = li.querySelector('font');
    const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || NAV_BLOCKLIST.test(text)) continue;

    const id = anchor?.id || null;
    const isSelectable = [...li.classList].some((c) => c.startsWith('select_form_'));
    const fontColor = font?.getAttribute('color')?.toUpperCase() || '';
    const fontText = (font?.textContent || '').replace(/\s+/g, ' ').trim();

    let remaining = 0;
    const remainZh = text.match(/剩餘\s*(\d+)/);
    const remainEn = text.match(/(\d+)\s*seat\(s\)\s*remaining/i);
    if (remainZh) remaining = parseInt(remainZh[1], 10);
    else if (remainEn) remaining = parseInt(remainEn[1], 10);

    const hotSelling = /熱賣中|熱銷中/i.test(text) || /熱賣中|熱銷中/i.test(fontText);
    const explicitlySoldOut = /已售完/i.test(text) || /Sold\s*out/i.test(text);
    const graySoldOut = fontColor === '#AAAAAA' && explicitlySoldOut;
    const soldOut = explicitlySoldOut || graySoldOut || (!anchor && !isSelectable);
    const available = !soldOut && isSelectable && Boolean(anchor) && (remaining > 0 || hotSelling || fontColor === '#FF0000');
    const isIgnored = text.includes('輪椅') || text.includes('身障');

    const name = stripName(text);
    if (!name || name.length < 2) continue;

    const dedupeKey = `${id || ''}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    sections.push({
      id,
      href: anchor?.href || null,
      name,
      remaining: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
      hotSelling,
      available,
      soldOut: !available,
      clickable: isSelectable && Boolean(anchor),
    });

    if (available && !isIgnored && anchor) {
      candidates.push({ name, anchor });
    }
  }

  let chosen = null;
  if (markRandomAvailable && candidates.length > 0) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    pick.anchor.setAttribute('data-killer-target', 'true');
    chosen = { name: pick.name };
  }

  return { sections, chosen };
}

async function monitorQueueAndRetry(page, site, availableSectionName, tixuisid) {
  const siteId = site.id;
  const domain = '.tixcraft.com';
  // activeCartTasks.add(siteId) 已經在 attemptAddToCart 剛開始就設定好了

  try {
    let keepRetrying = true;

    while (keepRetrying) {
      const currentSiteState = await sitesStore.getSiteById(siteId);
      if (!currentSiteState || !currentSiteState.enabled) {
        log.info('tixcraft', `[${siteId}] 站點已停用，背景排隊終止`);
        break;
      }

      log.info('tixcraft', `[${siteId}] 正在等待排隊跳轉...`);
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 300000 });
      } catch (err) {
        log.warn('tixcraft', `[${siteId}] 等待跳轉逾時或被彈窗中斷: ${err.message}`);
      }

      const currentUrl = page.url();
      if (currentUrl.endsWith('/ticket/order')) {
        log.info('tixcraft', `[${siteId}] 確認進入排隊頁面，持續監控跳轉...`);
        continue;
      } else if (currentUrl.includes('/ticket/cart') || currentUrl.includes('/ticket/checkout')) {
        log.info('tixcraft', `[${siteId}] 🎉 成功加入購物車！`);
        await sitesStore.updateSite(siteId, { enabled: false });

        notifier.sendDirect(`🎉 [${site.label || '拓元演唱會'}] \n已成功加入購物車！\n\n⏰ 請在 10 分鐘內完成結帳！🔗 結帳連結：https://tixcraft.com/ticket/checkout`);

        // wait random ~3 seconds before closing
        const waitTime = 2000 + Math.random() * 2000;
        await new Promise((r) => setTimeout(r, waitTime));
        break; // finish
      } else {
        log.warn('tixcraft', `[${siteId}] 被踢出排隊或驗證碼錯誤，目前網址: ${currentUrl}`);

        await new Promise((r) => setTimeout(r, 1000));
        const checkSite = await sitesStore.getSiteById(siteId);
        if (!checkSite || !checkSite.enabled) break;

        let retryable = false;

        if (currentUrl.includes('/ticket/area')) {
          const isAvailable = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            // Tixcraft structure: parent li contains an a tag if clickable
            const link = el.closest('li').querySelector('a');
            if (link && !link.textContent.includes('售完')) {
              link.click();
              return true;
            }
            return false;
          }, `div[title="${availableSectionName}"]`);

          if (isAvailable) {
            log.info('tixcraft', `[${siteId}] 區域還有票，重新點擊進入...`);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
            retryable = true;
          }
        } else if (currentUrl.includes('/ticket/ticket')) {
          retryable = true;
        }

        if (!retryable) {
          log.warn('tixcraft', `[${siteId}] 票已售完或無法重試，終止搶票。`);
          notifier.sendDirect(`⚠️ [${site.label || '拓元演唱會'}] 重試失敗，票可能已售完。`);
          break;
        }

        log.info('tixcraft', `[${siteId}] 重新執行填寫數量與驗證碼...`);

        const targetQty = checkSite.targetQuantity || site.ticketQuantity || 2;
        await fillQuantityAndAgree(page, targetQty);

        const captchaText = await recognizeCaptcha(page, CAPTCHA_IMG_SELECTOR);
        if (captchaText) {
          await page.type(CAPTCHA_INPUT_SELECTOR, captchaText, { delay: 50 });
        }

        const submitted = await clickSubmit(page);

        if (submitted) {
          log.info('tixcraft', `[${siteId}] 重試：已自動送出，進入排隊觀察...`);
        } else {
          log.warn('tixcraft', `[${siteId}] 重試：未找到送出按鈕，終止`);
          break;
        }
      }
    }
  } catch (err) {
    log.error('tixcraft', `[${siteId}] 背景排隊監控發生錯誤: ${err.message}`);
  } finally {
    log.info('tixcraft', `[${siteId}] 背景任務結束，正在關閉分頁與清除狀態...`);
    activeCartTasks.delete(siteId);

    // Since keepAlive was true, we must manually close it here
    // Also remove the injected cookie to be safe
    await removeCookie(page, domain).catch(() => {});
    await page.close().catch(() => {});
    // 沒有其他殺手任務在進行時，直接關閉整個 killer 瀏覽器，而非只關分頁
    if (activeCartTasks.size === 0) {
      await resetBrowser('killer').catch(() => {});
    }
  }
}

const IGNORE_KEYWORDS = ['輪椅', '身障'];

function shouldIgnoreSection(name) {
  return IGNORE_KEYWORDS.some((kw) => name.includes(kw));
}

function classifySection(raw) {
  const name = raw.name || '';
  if (shouldIgnoreSection(name)) {
    return { ...raw, status: 'ignored', remaining: raw.remaining ?? 0 };
  }
  if (raw.available || raw.hotSelling || raw.remaining > 0) {
    return {
      ...raw,
      status: 'available',
      remaining: raw.remaining > 0 ? raw.remaining : null,
    };
  }
  if (raw.soldOut) {
    return { ...raw, status: 'soldOut', remaining: 0 };
  }
  return { ...raw, status: 'soldOut', remaining: 0 };
}

function summarize(sections) {
  let availableCount = 0;
  let soldOutCount = 0;
  let ignoredCount = 0;
  for (const s of sections) {
    if (s.status === 'available') availableCount += 1;
    else if (s.status === 'ignored') ignoredCount += 1;
    else soldOutCount += 1;
  }
  return { availableCount, soldOutCount, ignoredCount };
}

/**
 * 從 URL 中抽取 cookie 的 domain。
 * "https://teamear.tixcraft.com/ticket/area/..." → ".tixcraft.com"
 */
function extractCookieDomain(url) {
  try {
    const hostname = new URL(url).hostname; // e.g. "teamear.tixcraft.com"
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return '.' + parts.slice(-2).join('.'); // ".tixcraft.com"
    }
    return hostname;
  } catch {
    return '.tixcraft.com';
  }
}

/**
 * 注入 TIXUISID Cookie 到當前頁面。
 */
async function injectCookie(page, tixuisid, domain) {
  const currentUrl = page.url();

  // 先清除所有現存的 TIXUISID，避免出現相同名稱卻不同 domain 導致的雙胞胎 Cookie 衝突
  const existingCookies = await page.cookies(currentUrl);
  for (const c of existingCookies) {
    if (c.name === 'TIXUISID') {
      await page.deleteCookie({ name: c.name, domain: c.domain, path: c.path });
    }
  }

  await page.setCookie({
    name: 'TIXUISID',
    value: tixuisid,
    url: currentUrl.startsWith('http') ? currentUrl : 'https://tixcraft.com',
    domain: domain,
    path: '/',
    httpOnly: true,
    secure: true,
  });
  log.info('tixcraft', `已注入 TIXUISID Cookie (domain: ${domain}, url: ${currentUrl})`);
}

/**
 * 清除 TIXUISID Cookie，恢復匿名狀態。
 */
async function removeCookie(page, domain) {
  try {
    const cookies = await page.cookies(page.url());
    for (const c of cookies) {
      await page.deleteCookie({ name: c.name, domain: c.domain });
    }
    log.info('tixcraft', '已清除所有 Tixcraft Cookie，徹底恢復匿名');
  } catch (err) {
    log.warn('tixcraft', `清除 Cookie 失敗: ${err.message}`);
  }
}

/**
 * 選擇票數並勾選同意條款（頁面重整後表單會重置，故抽成可重複呼叫）。
 */
async function fillQuantityAndAgree(page, desiredQty) {
  await page.waitForSelector('select.mobile-select, select[name*="quantity"], select#TicketForm_ticketPrice, #ticket-price-tbl', { timeout: 10_000 }).catch(() => {});

  const quantitySet = await page.evaluate((desired) => {
    const selectors = ['select.mobile-select', 'select[name*="quantity"]', 'select#TicketForm_ticketPrice', '.select-container select'];
    for (const sel of selectors) {
      const select = document.querySelector(sel);
      if (select && select.options.length > 1) {
        const validOptions = Array.from(select.options)
          .filter((opt) => parseInt(opt.value, 10) > 0)
          .map((opt) => ({ value: opt.value, num: parseInt(opt.value, 10) }));

        if (validOptions.length === 0) {
          select.value = select.options[1].value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, value: select.options[1].value, fallback: true };
        }

        const exact = validOptions.find((o) => o.num === desired);
        if (exact) {
          select.value = exact.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { found: true, value: exact.value, desired, actual: exact.num };
        }

        const best = validOptions.filter((o) => o.num <= desired).sort((a, b) => b.num - a.num)[0] || validOptions.sort((a, b) => b.num - a.num)[0];
        select.value = best.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: best.value, desired, actual: best.num, adjusted: true };
      }
    }
    return { found: false };
  }, desiredQty);

  if (quantitySet.found) {
    if (quantitySet.adjusted) {
      log.warn('tixcraft', `想要 ${quantitySet.desired} 張，但只剩 ${quantitySet.actual} 張可選，先買再說！`);
    } else {
      log.info('tixcraft', `已選擇票數: ${quantitySet.value}`);
    }
  } else {
    log.warn('tixcraft', '未找到票數選擇器，可能頁面結構不同');
  }

  const agreedChecked = await page.evaluate(() => {
    const selectors = ['#TicketForm_agree', 'input[name*="agree"]', 'input[type="checkbox"]'];
    for (const sel of selectors) {
      const cb = document.querySelector(sel);
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
        return true;
      }
      if (cb && cb.checked) return true;
    }
    return false;
  });

  if (agreedChecked) {
    log.info('tixcraft', '已勾選同意條款');
  } else {
    log.warn('tixcraft', '未找到同意條款 checkbox');
  }
}

/**
 * 點擊送出按鈕，回傳是否有按到。
 */
async function clickSubmit(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary, #submitBtn');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
}

/**
 * 截取驗證碼圖片並呼叫 OCR，成功回傳辨識文字，失敗回傳 null（不拋錯）。
 */
async function recognizeCaptcha(page, imgSelector) {
  try {
    // 等驗證碼圖片真的渲染完成（有寬高）才截圖，否則 screenshot 會報 Node has 0 width
    await page.waitForSelector(imgSelector, { visible: true, timeout: 5000 });
    await page.waitForFunction(
      (sel) => {
        const img = document.querySelector(sel);
        return !!img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0;
      },
      { timeout: 5000 },
      imgSelector
    );
    const captchaImg = await page.$(imgSelector);
    if (!captchaImg) return null;

    const base64Data = await captchaImg.screenshot({ encoding: 'base64' });
    log.info('tixcraft', '⏳ 正在呼叫 OCR API 解析驗證碼...');
    const response = await fetch(OCR_BASE64_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: base64Data }),
    });
    const result = await response.json();
    if (result.success && result.text) {
      log.info('tixcraft', `✅ 驗證碼解析成功: [${result.text}]`);
      return result.text;
    }
    log.warn('tixcraft', `❌ 驗證碼解析失敗: ${result.error || '未知錯誤'}`);
    return null;
  } catch (err) {
    log.error('tixcraft', `❌ 自動驗證碼處理發生錯誤: ${err.message}`);
    return null;
  }
}

/**
 * 2b 人工處理視窗：保留瀏覽器最多 30 秒讓使用者手動填驗證碼。
 * 期間若使用者送出成功（離開 ticket 頁），交給背景排隊監控；逾時則自動關閉 Killer 並交回 Scout。
 */
async function watchManualCaptcha(page, site, domain) {
  const MANUAL_WINDOW_MS = 30_000;
  try {
    await page.waitForFunction(() => !location.href.includes('/ticket/ticket'), { timeout: MANUAL_WINDOW_MS, polling: 1000 });
    log.info('tixcraft', `[${site.id}] 偵測到手動送出，移交背景排隊監控`);
    monitorQueueAndRetry(page, site, '', site.tixuisid).catch((err) => {
      log.error('tixcraft', `背景排隊監控發生未預期錯誤: ${err.message}`);
    });
    return; // 後續清理交給 monitorQueueAndRetry
  } catch {
    log.warn('tixcraft', `[${site.id}] 手動處理逾時 30 秒，自動關閉 Killer 並交回 Scout 重新輪詢`);
  }

  await removeCookie(page, domain).catch(() => {});
  activeCartTasks.delete(site.id);
  await page.close().catch(() => {});
  if (activeCartTasks.size === 0) {
    await resetBrowser('killer').catch(() => {});
  }
}

/**
 * 嘗試自動加車流程。
 * 回傳 { success, message }
 */
async function attemptAddToCart(site) {
  if (activeCartTasks.has(site.id)) {
    return { success: false, message: 'Killer 已經在為此活動搶票中' };
  }
  activeCartTasks.add(site.id);

  const domain = extractCookieDomain(site.url);

  // 用 killer 角色開啟分頁
  return await withPage({ role: 'killer' }, async (killerPage) => {
    // 自動處理所有 alert / confirm / prompt 彈窗
    killerPage.on('dialog', async (dialog) => {
      log.info('tixcraft', `[Killer] 偵測到彈窗 [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });

    try {
      // Step 1: 注入 TIXUISID Cookie
      await injectCookie(killerPage, site.tixuisid, domain);

      // Step 2: 前往活動頁面並實作「遞增式重試 (Backoff Reload)」
      // 一開始用很短的逾時快速重整，卡住才逐次 ×2 拉長，避免瘋狂重整也避免一開始等太久
      let areaLoaded = false;
      const MAX_RETRIES = 5;
      const BASE_TIMEOUT = 2500; // 第一次 2.5s，之後 5s / 10s / 20s / 20s(封頂)
      const MAX_TIMEOUT = 20000;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const gotoTimeout = Math.min(BASE_TIMEOUT * 2 ** (attempt - 1), MAX_TIMEOUT);
        const selectorTimeout = Math.round(gotoTimeout * 0.6);
        log.info('tixcraft', `[Killer] 前往活動頁面準備判斷區域 (嘗試 ${attempt}/${MAX_RETRIES}, goto逾時 ${gotoTimeout}ms / 等列表 ${selectorTimeout}ms): ${site.url}`);
        try {
          await killerPage.goto(site.url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
          await killerPage.waitForSelector('ul.area-list li, .area-list li, ul li', { timeout: selectorTimeout });
          areaLoaded = true;
          break; // 成功就脫離迴圈
        } catch (err) {
          log.warn('tixcraft', `[Killer] 網頁卡住或區域未出現，放棄並重整...`);
        }
      }

      if (!areaLoaded) {
        return { success: false, message: 'Killer 多次嘗試載入區域皆卡住，放棄本次任務' };
      }

      // Step 2.5: Killer 判斷有票的區域並隨機選一個（共用 parseAreaList 標記，於下方點擊）
      const { chosen: clickedAreaInfo } = await killerPage.evaluate(parseAreaList, { markRandomAvailable: true });

      if (!clickedAreaInfo) {
        return { success: false, message: 'Killer 找不到可點擊的購票連結（票已售完）' };
      }

      log.info('tixcraft', `[Killer] 隨機選擇區域: ${clickedAreaInfo.name}`);

      try {
        // 點擊被標記的區域連結並等待跳轉，逾時才視為卡住中斷
        await Promise.all([killerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }), killerPage.click('a[data-killer-target="true"]')]);
      } catch (err) {
        log.warn('tixcraft', `[Killer] 點擊區域或跳轉失敗，放棄並交回給 Scout 重新發起: ${err.message}`);
        return { success: false, message: '點擊區域後跳轉卡住，放棄本次任務' };
      }

      // 檢查是否被導向登入頁面（表示 Cookie 無效）
      const currentUrl = killerPage.url();
      if (/\/login|\/member\/login/i.test(currentUrl)) {
        return {
          success: false,
          message: 'TIXUISID 已失效，被導向登入頁面。請更新 Cookie！',
        };
      }

      // Step 4~7: 全自動填單與驗證碼辨識，最多重試 5 次（每次失敗就重整頁面換新驗證碼）
      const captchaInputSelector = CAPTCHA_INPUT_SELECTOR;
      const captchaImgSelector = CAPTCHA_IMG_SELECTOR;
      const desiredQty = site.ticketQuantity || 1;
      const MAX_CAPTCHA_ATTEMPTS = 5;

      let submitted = false;

      for (let cAttempt = 1; cAttempt <= MAX_CAPTCHA_ATTEMPTS; cAttempt++) {
        // 重整後表單會重置，每次都重新選票數＋勾同意
        await fillQuantityAndAgree(killerPage, desiredQty);

        const hasCaptcha = await killerPage.evaluate((sel) => !!document.querySelector(sel), captchaInputSelector);

        if (!hasCaptcha) {
          submitted = await clickSubmit(killerPage);
          if (submitted) log.info('tixcraft', '🚀 未偵測到驗證碼，已自動按 Submit！');
          break;
        }

        log.info('tixcraft', `🔍 偵測到驗證碼，開始自動辨識 (第 ${cAttempt}/${MAX_CAPTCHA_ATTEMPTS} 次)...`);
        const captchaText = await recognizeCaptcha(killerPage, captchaImgSelector);

        if (captchaText) {
          await killerPage.type(captchaInputSelector, captchaText, { delay: 20 });
          submitted = await clickSubmit(killerPage);
          if (submitted) {
            log.info('tixcraft', '🚀 已自動送出驗證碼！');
          } else {
            log.warn('tixcraft', '⚠️ 驗證碼填寫完畢，但未找到送出按鈕！');
          }
          break; // 有送出（或找不到按鈕）就交給後續流程
        }

        // 這次辨識失敗：還有次數就重整頁面換新驗證碼再試
        if (cAttempt < MAX_CAPTCHA_ATTEMPTS) {
          log.warn('tixcraft', `[Killer] 驗證碼辨識失敗，重整頁面換新驗證碼後重試 (${cAttempt}/${MAX_CAPTCHA_ATTEMPTS})...`);
          await killerPage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await killerPage.waitForSelector(captchaInputSelector, { timeout: 5000 }).catch(() => {});
        }
      }

      if (submitted) {
        log.info('tixcraft', '✅ 已自動按下 SUBMIT！將進入背景排隊與重試監控程序...');

        // 開啟 keepAlive
        killerPage.keepAlive = true;

        // 啟動背景任務 (fire and forget)
        monitorQueueAndRetry(killerPage, site, clickedAreaInfo.name, site.tixuisid).catch((err) => {
          log.error('tixcraft', `背景排隊監控發生未預期錯誤: ${err.message}`);
        });

        return { success: true, message: '已移交背景排隊與重試監控，主輪詢將繼續' };
      }

      // 自動辨識連續 5 次都失敗
      const globalSettings = await settings.getSettings();
      if (globalSettings.unattendedMode) {
        // 離座模式：不等人工，直接放棄交回 Scout（finally 會關閉 Killer 並解鎖）
        log.warn('tixcraft', '🚪 離座模式：驗證碼自動辨識多次失敗，放棄本次並交回 Scout 重新輪詢');
        notifier.sendDirect(`🚪 [${site.label || '拓元演唱會'}] 離座模式：驗證碼辨識失敗，已自動放棄，將由 Scout 繼續輪詢。`);
        return { success: false, message: '離座模式：驗證碼辨識失敗，已交回 Scout' };
      }

      // 一般模式：保留瀏覽器 30 秒給人工填寫，逾時自動關閉並交回 Scout
      killerPage.keepAlive = true;
      notifier.sendDirect(`✋ [${site.label || '拓元演唱會'}] 驗證碼自動辨識失敗，已保留瀏覽器 30 秒，請盡快手動填寫並送出！`);
      watchManualCaptcha(killerPage, site, domain).catch((err) => {
        log.error('tixcraft', `手動驗證碼監控發生未預期錯誤: ${err.message}`);
      });
      return { success: true, message: '驗證碼自動辨識失敗，已保留瀏覽器 30 秒等待手動處理', needManualCaptcha: true };
    } finally {
      // 如果沒有開啟 keepAlive（例如沒找到 submit 或是出錯），才清除 Cookie
      if (!killerPage.keepAlive) {
        await removeCookie(killerPage, domain);
        activeCartTasks.delete(site.id); // 沒有移交背景時才在這裡解鎖
        // 沒有其他殺手任務（含背景排隊）在進行時，直接關閉整個 killer 瀏覽器，而非只關分頁
        if (activeCartTasks.size === 0) {
          await resetBrowser('killer').catch(() => {});
        }
      }
    }
  });
}

const AREA_LIST_SELECTOR = 'ul.area-list li, .area-list li, ul li';

/**
 * 導航到區域頁並確保區域列表就緒（混合策略）。
 * - 快路徑：domcontentloaded 載入（售票頁有輪詢/廣告，networkidle2 會等不到閒置而拖慢；
 *   區域列表本來就在初始 HTML，暖態下這條最快，實測比 networkidle2 快約 60%）。
 * - 退路：快路徑沒即時等到列表（常見於開機/失憶後第一輪卡在 Cloudflare 挑戰頁，
 *   domcontentloaded 會在挑戰頁就返回），改用 networkidle2 重載一次，等網路真正閒置、
 *   跨過挑戰解算，拿回冷態韌性。
 * @returns {Promise<boolean>} 區域列表是否就緒
 */
async function gotoAreaPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

  let ready = await page
    .waitForSelector(AREA_LIST_SELECTOR, { timeout: 12_000 })
    .then(() => true)
    .catch(() => false);

  if (!ready) {
    log.info('tixcraft', '[Scout] 列表未即時出現，改用 networkidle2 重載一次（冷載入/挑戰頁退路）…');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => {});
    ready = await page
      .waitForSelector(AREA_LIST_SELECTOR, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  }

  return ready;
}

async function scrapeTixcraft(url, site = {}) {
  if (activeCartTasks.has(site.id)) {
    log.info('tixcraft', `[${site.id}] 正在背景排隊搶票中，暫停主輪詢`);
    return {
      scraperId: 'tixcraft',
      scrapedAt: new Date().toISOString(),
      sections: [],
      summary: { total: 0, availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
      cartResult: { success: true, message: '背景排隊中' },
    };
  }

  const result = await withPage(async (page) => {
    const listReady = await gotoAreaPage(page, url);

    if (!listReady) {
      // 兩條路徑都沒等到列表：先確認是不是被 WAF / Cloudflare 擋住的挑戰頁。
      // 是的話拋錯，讓 scheduler 的連續阻擋偵測（consecutiveBlocks）能真正計數並觸發失憶；
      // 否則才視為「目前無票」回傳空結果。
      const blockType = await page.evaluate(detectBlockPage).catch(() => null);
      if (blockType) {
        log.warn('tixcraft', `[Scout] 偵測到疑似 WAF 阻擋頁：${blockType}`);
        throw new Error(`WAF blocked: ${blockType}`);
      }
      log.warn('tixcraft', `[Scout] 等待區域列表出現逾時，視為目前無票處理。`);
      return {
        sections: [],
        summary: { availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
        cartResult: null,
      };
    }

    // 模擬人類瀏覽行為
    await simulateHumanBehavior(page);

    const { sections: rawSections } = await page.evaluate(parseAreaList);

    const sections = rawSections.map(classifySection).sort((a, b) => {
      const order = { available: 0, soldOut: 1, ignored: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });

    const summary = summarize(sections);

    // === 自動加車邏輯 ===
    let cartResult = null;
    const globalSettings = await settings.getSettings();
    const tixuisid = globalSettings.tixuisid;
    const ticketQuantity = globalSettings.ticketQuantity || 1;
    if (summary.availableCount > 0 && tixuisid) {
      if (activeCartTasks.has(site.id)) {
        log.info('tixcraft', `[Scout] Killer 正在為 ${site.label} 搶票中，略過本次重複加車...`);
        cartResult = null; // 不產生重複的加車結果
      } else {
        log.info('tixcraft', `🎯 偵測到有票，將交由殺手 (Killer) 開啟網頁進行判斷與隨機選區（目標 ${ticketQuantity} 張）...`);
        // 使用獨立的 attemptAddToCart 處理（不鎖死當前的探子 Page）
        attemptAddToCart({ ...site, tixuisid, ticketQuantity })
          .then((res) => {
            if (res && res.message) {
              log.info('tixcraft', `加車結果: ${res.message}`);
            }
          })
          .catch((err) => {
            log.error('tixcraft', `加車流程例外: ${err.message}`);
          });

        cartResult = { success: true, message: '已移交殺手進程處理' };
      }
    } else if (summary.availableCount === 0 && tixuisid) {
      // 沒票，確保保持匿名
      log.info('tixcraft', '[Scout] 無可用票區，維持匿名輪詢');
    }

    return { sections, summary, cartResult };
  });

  return {
    scraperId: 'tixcraft',
    scrapedAt: new Date().toISOString(),
    sections: result.sections,
    summary: result.summary,
    cartResult: result.cartResult,
  };
}

async function fetchCaptcha() {
  try {
    const captchaBaseDir = path.join(__dirname, '../../captchas');

    // 確保 captchas 資料夾存在
    if (!fs.existsSync(captchaBaseDir)) {
      fs.mkdirSync(captchaBaseDir, { recursive: true });
    }

    const origin = 'https://tixcraft.com';
    const res = await fetch(`${origin}/ticket/captcha?v=${Date.now()}`);

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      // 直接存檔到 captchas 資料夾內
      const filename = path.join(captchaBaseDir, `img_${Date.now()}.jpg`);
      fs.writeFileSync(filename, buffer);
    }
  } catch (err) {
    // 靜默失敗
  }
}

function matches(url) {
  return /tixcraft\.com\/ticket\/area\//i.test(url);
}

module.exports = {
  scrapeTixcraft,
  fetchCaptcha,
  matches,
  // 匯出供測試使用
  parseAreaList,
  detectBlockPage,
  gotoAreaPage,
  CAPTCHA_IMG_SELECTOR,
  CAPTCHA_INPUT_SELECTOR,
};

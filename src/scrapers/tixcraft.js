const fs = require('fs');
const path = require('path');
const { withPage, simulateHumanBehavior } = require('./browser');
const log = require('../logger');
const notifier = require('../notifier');
const settings = require('../config/settings');
const sitesStore = require('../config/sites');

const activeCartTasks = new Set();

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

        notifier.sendDirect(
          `🎉 [${site.label || '拓元演唱會'}] \n已成功加入購物車！\n\n⏰ 請在 10 分鐘內完成結帳！🔗 結帳連結：https://tixcraft.com/ticket/checkout`
        );

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
        await page.evaluate((qty) => {
          const selects = Array.from(document.querySelectorAll('select'));
          for (const s of selects) {
            if (s.id && s.id.includes('TicketForm_ticketPrice')) {
              const opts = Array.from(s.querySelectorAll('option')).map((o) => parseInt(o.value, 10));
              const maxQty = Math.max(...opts.filter((v) => !isNaN(v)));
              if (maxQty > 0) {
                const val = Math.min(qty, maxQty);
                s.value = val;
                s.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
          return false;
        }, targetQty);

        await page.evaluate(() => {
          const chk = document.querySelector('input[type="checkbox"]#TicketForm_agree');
          if (chk && !chk.checked) {
            chk.click();
          }
        });

        const captchaImg = await page.$('#TicketForm_verifyCode-image');
        if (captchaImg) {
          try {
            const base64 = await captchaImg.screenshot({ encoding: 'base64' });
            const res = await fetch('http://127.0.0.1:8000/ocr/base64', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image_base64: base64 }),
            });
            const data = await res.json();
            if (data.success && data.text) {
              await page.type('#TicketForm_verifyCode', data.text, { delay: 50 });
            }
          } catch (e) {
            log.warn('tixcraft', `[${siteId}] OCR failed: ${e.message}`);
          }
        }

        const submitted = await page.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary, #submitBtn');
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });

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
  return await withPage({ role: 'killer', keepAlive: true }, async (killerPage) => {
    // 自動處理所有 alert / confirm / prompt 彈窗
    killerPage.on('dialog', async (dialog) => {
      log.info('tixcraft', `[Killer] 偵測到彈窗 [${dialog.type()}]: ${dialog.message()}`);
      await dialog.accept();
    });

    try {
      // Step 1: 注入 TIXUISID Cookie
      await injectCookie(killerPage, site.tixuisid, domain);

      // Step 2: 前往活動頁面並實作「極速重試 (Aggressive Reload)」
      let areaLoaded = false;
      const MAX_RETRIES = 5;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        log.info('tixcraft', `[Killer] 前往活動頁面準備判斷區域 (嘗試 ${attempt}/${MAX_RETRIES}): ${site.url}`);
        try {
          // 只要 3 秒沒載入基礎 DOM，或多等 1.5 秒票區沒出來，就視為卡住重整
          await killerPage.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 3000 });
          await killerPage.waitForSelector('ul.area-list li, .area-list li, ul li', { timeout: 1500 });
          areaLoaded = true;
          break; // 成功就脫離迴圈
        } catch (err) {
          log.warn('tixcraft', `[Killer] 網頁卡住或區域未出現，放棄並重整...`);
        }
      }

      if (!areaLoaded) {
        return { success: false, message: 'Killer 多次嘗試載入區域皆卡住，放棄本次任務' };
      }

      // Step 2.5: Killer 判斷有票的區域並隨機選一個點擊
      const clickedAreaInfo = await killerPage.evaluate(() => {
        const NAV_BLOCKLIST = /^(Events|My Tickets|Sign In|Menu|Home|Clear|Search)/i;
        const listRoots = document.querySelectorAll('ul.area-list, .zone.area-list');
        const lis =
          listRoots.length > 0
            ? Array.from(listRoots).flatMap((root) => [...root.querySelectorAll('li')])
            : [...document.querySelectorAll('li')];

        const availableLinks = [];

        for (const [index, li] of lis.entries()) {
          const anchor = li.querySelector('a');
          const font = li.querySelector('font');
          const text = (li.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || NAV_BLOCKLIST.test(text)) continue;

          // 忽略輪椅席
          if (text.includes('輪椅') || text.includes('身障')) continue;

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
          const available =
            !soldOut && isSelectable && Boolean(anchor) && (remaining > 0 || hotSelling || fontColor === '#FF0000');

          if (available) {
            let name = text
              .replace(/剩餘\s*\d+/g, '')
              .replace(/\d+\s*seat\(s\)\s*remaining/gi, '')
              .replace(/熱賣中|熱銷中/gi, '')
              .replace(/已售完/gi, '')
              .replace(/Sold\s*out/gi, '')
              .trim();
            // 在元素上標記一個屬性方便我們從外面抓取
            if (anchor) {
              anchor.setAttribute('data-killer-target', 'true');
              availableLinks.push({ index, name, selector: `li:nth-child(${index + 1}) a[data-killer-target="true"]` });
            }
          }
        }

        if (availableLinks.length === 0) {
          return null;
        }

        // 隨機選擇一個
        const randomIndex = Math.floor(Math.random() * availableLinks.length);
        return availableLinks[randomIndex];
      });

      if (!clickedAreaInfo) {
        return { success: false, message: 'Killer 找不到可點擊的購票連結（票已售完）' };
      }

      log.info('tixcraft', `[Killer] 隨機選擇區域: ${clickedAreaInfo.name}`);

      try {
        // 點擊後只等 3.5 秒，卡住就直接拋錯中斷
        await Promise.all([
          killerPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3500 }),
          killerPage.click(clickedAreaInfo.selector),
        ]);
      } catch (err) {
        log.warn('tixcraft', `[Killer] 點擊區域後卡住超過 3.5 秒，放棄並交回給 Scout 重新發起`);
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

      // Step 4: 等待票數選擇表單出現
      try {
        await killerPage.waitForSelector(
          'select.mobile-select, select[name*="quantity"], select#TicketForm_ticketPrice, #ticket-price-tbl',
          { timeout: 10_000 }
        );
      } catch {
        // 可能頁面結構不同，繼續嘗試
        log.warn('tixcraft', '[Killer] 等待票數選擇器逾時，嘗試繼續...');
      }

      // Step 5: 選擇票數（從全域設定讀取，若不夠則選最大可用數量）
      const desiredQty = site.ticketQuantity || 1;
      const quantitySet = await killerPage.evaluate((desired) => {
        const selectors = [
          'select.mobile-select',
          'select[name*="quantity"]',
          'select#TicketForm_ticketPrice',
          '.select-container select',
        ];
        for (const sel of selectors) {
          const select = document.querySelector(sel);
          if (select && select.options.length > 1) {
            // 收集所有可用的數量選項（排除 0 或空值）
            const validOptions = Array.from(select.options)
              .filter((opt) => parseInt(opt.value, 10) > 0)
              .map((opt) => ({ value: opt.value, num: parseInt(opt.value, 10) }));

            if (validOptions.length === 0) {
              // fallback: 直接選第二個選項
              select.value = select.options[1].value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return {
                found: true,
                value: select.options[1].value,
                fallback: true,
              };
            }

            // 優先選想要的數量
            const exact = validOptions.find((o) => o.num === desired);
            if (exact) {
              select.value = exact.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              return {
                found: true,
                value: exact.value,
                desired,
                actual: exact.num,
              };
            }

            // 想要的數量不夠，選最接近但不超過的最大值（先買再說）
            const best =
              validOptions.filter((o) => o.num <= desired).sort((a, b) => b.num - a.num)[0] ||
              validOptions.sort((a, b) => b.num - a.num)[0]; // 如果都大於 desired，選最大的

            select.value = best.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return {
              found: true,
              value: best.value,
              desired,
              actual: best.num,
              adjusted: true,
            };
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

      // Step 6: 勾選同意條款
      const agreedChecked = await killerPage.evaluate(() => {
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

      // Step 7: 驗證碼處理 — 目前採全自動模式
      const captchaInputSelector = '#TicketForm_verifyCode, input[name*="verify"], input[name*="captcha"]';
      const captchaImgSelector = '#TicketForm_imageRandom, img[src*="captcha"], img[id*="captcha"]';

      const hasCaptcha = await killerPage.evaluate((sel) => {
        const input = document.querySelector(sel);
        return !!input;
      }, captchaInputSelector);

      let submitted = false;

      if (hasCaptcha) {
        log.info('tixcraft', '🔍 偵測到驗證碼輸入框，開始自動辨識...');
        try {
          // 等待驗證碼圖片出現
          await killerPage.waitForSelector(captchaImgSelector, { timeout: 3000 });
          const captchaImg = await killerPage.$(captchaImgSelector);

          if (captchaImg) {
            // 截取驗證碼圖片轉 Base64
            const base64Data = await captchaImg.screenshot({ encoding: 'base64' });

            log.info('tixcraft', '⏳ 正在呼叫 OCR API 解析驗證碼...');

            // 呼叫本地端的 Python OCR 微服務
            const response = await fetch('http://127.0.0.1:8000/ocr/base64', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ image_base64: base64Data }),
            });

            const result = await response.json();

            if (result.success && result.text) {
              log.info('tixcraft', `✅ 驗證碼解析成功: [${result.text}]`);

              // 將驗證碼填入輸入框 (移除 delay 追求極致速度)
              await killerPage.type(captchaInputSelector, result.text, { delay: 20 });

              // 自動按 submit
              submitted = await killerPage.evaluate(() => {
                const btn = document.querySelector(
                  'button[type="submit"], input[type="submit"], .btn-primary, #submitBtn'
                );
                if (btn) {
                  btn.click();
                  return true;
                }
                return false;
              });

              if (submitted) {
                log.info('tixcraft', '🚀 已自動送出驗證碼！');
              } else {
                log.warn('tixcraft', '⚠️ 驗證碼填寫完畢，但未找到送出按鈕！');
              }
            } else {
              log.warn('tixcraft', `❌ 驗證碼解析失敗: ${result.error || '未知錯誤'}，請手動介入！`);
              return {
                success: true,
                message: '驗證碼自動解析失敗，請切換至瀏覽器手動填寫！',
                needManualCaptcha: true,
              };
            }
          }
        } catch (err) {
          log.error('tixcraft', `❌ 自動驗證碼處理發生錯誤: ${err.message}`);
          return {
            success: true,
            message: '驗證碼處理過程發生錯誤，請切換至瀏覽器手動填寫！',
            needManualCaptcha: true,
          };
        }
      } else {
        // 沒有驗證碼的情況（罕見），自動按 submit
        submitted = await killerPage.evaluate(() => {
          const btn = document.querySelector('button[type="submit"], input[type="submit"], .btn-primary, #submitBtn');
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });
        if (submitted) {
          log.info('tixcraft', '🚀 未偵測到驗證碼，已自動按 Submit！');
        }
      }

      if (submitted) {
        log.info('tixcraft', '✅ 已自動按下 SUBMIT！將進入背景排隊與重試監控程序...');

        // 開啟 keepAlive
        killerPage.keepAlive = true;

        // 啟動背景任務 (fire and forget)
        monitorQueueAndRetry(killerPage, site, clickedAreaName, site.tixuisid).catch((err) => {
          log.error('tixcraft', `背景排隊監控發生未預期錯誤: ${err.message}`);
        });

        return { success: true, message: '已移交背景排隊與重試監控，主輪詢將繼續' };
      }

      return { success: true, message: '已填好票數與條款，但未找到 submit 按鈕' };
    } finally {
      // 如果沒有開啟 keepAlive（例如沒找到 submit 或是出錯），才清除 Cookie
      if (!killerPage.keepAlive) {
        await removeCookie(killerPage, domain);
        activeCartTasks.delete(site.id); // 沒有移交背景時才在這裡解鎖
      }
    }
  });
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });

    try {
      await page.waitForSelector('ul.area-list li, .area-list li, ul li', {
        timeout: 15_000,
      });
    } catch (err) {
      log.warn('tixcraft', `[Scout] 等待區域列表出現逾時，視為目前無票處理。`);
      return {
        sections: [],
        summary: { availableCount: 0, soldOutCount: 0, ignoredCount: 0 },
        cartResult: null,
      };
    }

    // 模擬人類瀏覽行為
    await simulateHumanBehavior(page);

    const rawSections = await page.evaluate(() => {
      const items = [];
      const seen = new Set();
      const NAV_BLOCKLIST = /^(Events|My Tickets|Sign In|Menu|Home|Clear|Search)/i;

      const listRoots = document.querySelectorAll('ul.area-list, .zone.area-list');
      const lis =
        listRoots.length > 0
          ? Array.from(listRoots).flatMap((root) => [...root.querySelectorAll('li')])
          : [...document.querySelectorAll('li')];

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

        const available =
          !soldOut && isSelectable && Boolean(anchor) && (remaining > 0 || hotSelling || fontColor === '#FF0000');

        let name = text
          .replace(/剩餘\s*\d+/g, '')
          .replace(/\d+\s*seat\(s\)\s*remaining/gi, '')
          .replace(/熱賣中|熱銷中/gi, '')
          .replace(/已售完/gi, '')
          .replace(/Sold\s*out/gi, '')
          .trim();

        if (!name || name.length < 2) continue;

        const dedupeKey = `${id || ''}:${name}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        items.push({
          id,
          href: anchor?.href || null,
          name,
          remaining: Number.isFinite(remaining) && remaining > 0 ? remaining : 0,
          hotSelling,
          available,
          soldOut: !available,
          clickable: isSelectable && Boolean(anchor),
        });
      }

      return items;
    });

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
        log.info(
          'tixcraft',
          `🎯 偵測到有票，將交由殺手 (Killer) 開啟網頁進行判斷與隨機選區（目標 ${ticketQuantity} 張）...`
        );
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

module.exports = { scrapeTixcraft, fetchCaptcha, matches };

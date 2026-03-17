/**
 * K.Y.T. Upgrade Banner — Content Script (ISOLATED world)
 * Shows a non-intrusive bottom banner when the user hits their daily turn limit.
 * Rendered in Shadow DOM for style isolation from host page.
 *
 * Listens for KYT_TURN_LIMIT_REACHED messages from the background service worker.
 * Dismiss hides the banner for this tab session (sessionStorage).
 */

(function () {
  'use strict';

  var DISMISS_KEY = 'kyt_upgrade_banner_dismissed';
  var bannerId = 'kyt-upgrade-banner-host';
  var bannerShown = false;

  function isDismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  }

  function setDismissed() {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* ok */ }
  }

  function createBanner(used, limit, tier) {
    if (bannerShown || isDismissed()) return;
    if (document.getElementById(bannerId)) return;
    bannerShown = true;

    var host = document.createElement('div');
    host.id = bannerId;
    host.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;';

    var shadow = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; font-family: "SF Mono", "Fira Code", "Consolas", monospace; }',
      '.banner {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 12px 20px; background: #0a0a0c;',
      '  border-top: 1px solid rgba(255,59,59,0.3);',
      '  color: #e8e8ec; font-size: 13px;',
      '  animation: slideUp 0.3s ease-out;',
      '  background-image: repeating-linear-gradient(',
      '    0deg, transparent, transparent 2px, rgba(255,255,255,0.015) 2px, rgba(255,255,255,0.015) 4px',
      '  );',
      '}',
      '.msg { display: flex; align-items: center; gap: 8px; }',
      '.dot { width: 8px; height: 8px; border-radius: 50%; background: #FFB800; flex-shrink: 0; }',
      '.actions { display: flex; align-items: center; gap: 12px; }',
      '.upgrade-btn {',
      '  font-family: inherit; font-size: 12px; padding: 6px 16px;',
      '  background: #39FF14; color: #080809; border: none; border-radius: 3px;',
      '  cursor: pointer; font-weight: 600; text-decoration: none;',
      '  box-shadow: 0 0 8px rgba(57,255,20,0.3);',
      '  transition: box-shadow 0.2s;',
      '}',
      '.upgrade-btn:hover { box-shadow: 0 0 16px rgba(57,255,20,0.5); }',
      '.dismiss {',
      '  background: none; border: none; color: #8a8a94; cursor: pointer;',
      '  font-size: 18px; padding: 4px 8px; line-height: 1;',
      '}',
      '.dismiss:hover { color: #e8e8ec; }',
      '@keyframes slideUp {',
      '  from { transform: translateY(100%); opacity: 0; }',
      '  to { transform: translateY(0); opacity: 1; }',
      '}',
    ].join('\n');

    var banner = document.createElement('div');
    banner.className = 'banner';

    var tierLabel = tier === 'free' ? 'Pro' : 'Max';
    var tierPrice = tier === 'free' ? '$7/mo' : '$15/mo';

    banner.innerHTML = [
      '<div class="msg">',
      '  <span class="dot"></span>',
      '  <span>K.Y.T. memory paused \u2014 ' + used + '/' + limit + ' turns used today</span>',
      '</div>',
      '<div class="actions">',
      '  <button class="upgrade-btn">',
      '    Upgrade to ' + tierLabel + ' \u2014 ' + tierPrice,
      '  </button>',
      '  <button class="dismiss" aria-label="Dismiss">\u00D7</button>',
      '</div>',
    ].join('');

    shadow.appendChild(style);
    shadow.appendChild(banner);

    var upgradeBtn = banner.querySelector('.upgrade-btn');
    upgradeBtn.addEventListener('click', function () {
      upgradeBtn.textContent = 'Loading\u2026';
      upgradeBtn.disabled = true;
      chrome.runtime.sendMessage({
        type: 'KYT_START_CHECKOUT',
        tier: tier === 'free' ? 'pro' : 'max',
        interval: 'monthly'
      }, function (resp) {
        if (resp && resp.success) {
          host.remove();
          bannerShown = false;
        } else {
          upgradeBtn.textContent = 'Upgrade to ' + tierLabel + ' \u2014 ' + tierPrice;
          upgradeBtn.disabled = false;
        }
      });
    });

    var dismissBtn = banner.querySelector('.dismiss');
    dismissBtn.addEventListener('click', function () {
      host.remove();
      setDismissed();
      bannerShown = false;
    });

    document.body.appendChild(host);
  }

  // Listen for turn limit messages from background
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'KYT_TURN_LIMIT_REACHED') {
        createBanner(msg.used, msg.limit, msg.tier);
      }
    });
  }
})();

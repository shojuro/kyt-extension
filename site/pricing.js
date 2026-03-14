/* K.Y.T. Pricing Page — Founder banner + FAQ accordion */
(function () {
  'use strict';

  var SUPABASE_FN_BASE = 'https://svrcvfzlwhnixzuxaccf.supabase.co/functions/v1';

  // ============================================
  // FOUNDER BANNER
  // ============================================
  var bannerSection = document.getElementById('founder-banner-section');

  if (bannerSection) {
    fetch(SUPABASE_FN_BASE + '/get_founder_count')
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;

        var remaining = data.total - data.count;
        var price = data.count < 100 ? '$5' : '$10';
        var soldOut = data.count >= data.total;

        if (soldOut) return; // keep hidden

        var priceEl = document.getElementById('founder-price');
        var spotsEl = document.getElementById('founder-spots-text');
        var ctaEl = document.getElementById('founder-cta');

        if (priceEl) priceEl.textContent = price;
        if (spotsEl) spotsEl.textContent = remaining + ' of ' + data.total + ' spots left.';

        bannerSection.hidden = false;
      })
      .catch(function () {
        // Silently keep banner hidden on error
      });
  }

  // ============================================
  // FAQ ACCORDION
  // ============================================
  document.querySelectorAll('.faq-q').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.faq-item');
      var isOpen = item.classList.contains('open');

      // Close all
      document.querySelectorAll('.faq-item').forEach(function (el) {
        el.classList.remove('open');
        el.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });

      // Open clicked (if it was closed)
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });
})();

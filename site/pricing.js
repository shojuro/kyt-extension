/* K.Y.T. Pricing Page — Billing toggle + Founder banner + FAQ accordion */
(function () {
  'use strict';

  var SUPABASE_FN_BASE = 'https://svrcvfzlwhnixzuxaccf.supabase.co/functions/v1';

  // ============================================
  // PRICING DATA
  // ============================================
  var PRICES = {
    pro:  { monthly: '$7',  annual: '$5',  monthlyPeriod: '/month', annualPeriod: '/month, billed annually' },
    max:  { monthly: '$15', annual: '$12', monthlyPeriod: '/month', annualPeriod: '/month, billed annually' },
  };

  var isAnnual = false;

  // ============================================
  // BILLING TOGGLE
  // ============================================
  var toggle = document.getElementById('billing-toggle');
  var monthlyLabel = document.getElementById('billing-monthly-label');
  var annualLabel = document.getElementById('billing-annual-label');

  function updatePrices() {
    var mode = isAnnual ? 'annual' : 'monthly';
    var periodKey = isAnnual ? 'annualPeriod' : 'monthlyPeriod';

    var proPrice = document.getElementById('pro-price');
    var proPeriod = document.getElementById('pro-period');
    var maxPrice = document.getElementById('max-price');
    var maxPeriod = document.getElementById('max-period');

    if (proPrice) proPrice.textContent = PRICES.pro[mode];
    if (proPeriod) proPeriod.textContent = PRICES.pro[periodKey];
    if (maxPrice) maxPrice.textContent = PRICES.max[mode];
    if (maxPeriod) maxPeriod.textContent = PRICES.max[periodKey];
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      isAnnual = !isAnnual;
      toggle.setAttribute('aria-checked', String(isAnnual));
      if (monthlyLabel) monthlyLabel.classList.toggle('billing-toggle__label--active', !isAnnual);
      if (annualLabel) annualLabel.classList.toggle('billing-toggle__label--active', isAnnual);
      updatePrices();
    });
    // Set initial state
    if (monthlyLabel) monthlyLabel.classList.add('billing-toggle__label--active');
  }

  // ============================================
  // CHECKOUT BUTTONS
  // ============================================
  var proCta = document.getElementById('pro-cta');
  var maxCta = document.getElementById('max-cta');

  function handleCheckout(tier) {
    var interval = isAnnual ? 'annual' : 'monthly';
    // Redirect to checkout — for now, link to a signup/checkout flow
    // Once Stripe price IDs are live, this will call create-checkout edge function
    var checkoutUrl = SUPABASE_FN_BASE + '/create-checkout';
    // For unauthenticated users on the pricing page, redirect to extension install
    // Authenticated checkout happens from the popup
    window.location.href = '/?upgrade=' + tier + '&interval=' + interval;
  }

  if (proCta) {
    proCta.addEventListener('click', function () { handleCheckout('pro'); });
  }
  if (maxCta) {
    maxCta.addEventListener('click', function () { handleCheckout('max'); });
  }

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

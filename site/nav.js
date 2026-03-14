/* K.Y.T. Product Site — Shared Nav + Footer */
(function () {
  'use strict';

  const currentPath = window.location.pathname;

  function isActive(path) {
    return currentPath === path || currentPath === path + '/' ? ' site-nav__link--active' : '';
  }

  // NAV
  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  nav.setAttribute('aria-label', 'Main navigation');
  nav.innerHTML = `
    <div class="site-nav__inner">
      <a href="/" class="site-nav__logo" aria-label="K.Y.T. home">K.Y.T.</a>
      <button class="site-nav__toggle" aria-label="Toggle menu" aria-expanded="false">&#9776;</button>
      <ul class="site-nav__links">
        <li><a href="/features" class="site-nav__link${isActive('/features')}">Features</a></li>
        <li><a href="/pricing" class="site-nav__link${isActive('/pricing')}">Pricing</a></li>
        <li><a href="/docs" class="site-nav__link${isActive('/docs')}">Docs</a></li>
        <li><a href="/" class="site-nav__cta">Get K.Y.T.</a></li>
      </ul>
    </div>
  `;
  document.body.prepend(nav);

  // Mobile toggle
  const toggle = nav.querySelector('.site-nav__toggle');
  const links = nav.querySelector('.site-nav__links');
  toggle.addEventListener('click', function () {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  // FOOTER
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="site-footer__inner container">
      <a href="/" class="site-footer__logo">K.Y.T.</a>
      <ul class="site-footer__links">
        <li><a href="/privacy" class="site-footer__link">Privacy</a></li>
        <li><a href="/features" class="site-footer__link">Features</a></li>
        <li><a href="/pricing" class="site-footer__link">Pricing</a></li>
        <li><a href="/docs" class="site-footer__link">Docs</a></li>
      </ul>
      <p class="site-footer__tagline">Your conversations. Your memory. Your&nbsp;things.</p>
    </div>
  `;
  document.body.append(footer);

  // Scroll reveal for product pages
  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.reveal').forEach(function (el) {
    observer.observe(el);
  });
})();

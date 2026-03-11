/* ============================================
   K.Y.T. LANDING PAGE — main.js
   Boot sequence, scroll reveals, interactions
   K.I.T.T. segmented scanner engine
   CRT effects, terminal recovery, glitch
   ============================================ */

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ============================================
  // K.I.T.T. SCANNER ENGINE
  // 8-segment LED sweep with halogen trailing glow
  // ============================================
  const LED_COUNT = 8;
  const TRAIL_INTENSITIES = [5, 4, 3, 2, 1];
  const BASE_STEP_MS = 120;

  const scannerTracks = document.querySelectorAll('.hero__scanner-track');
  let scannerSpeed = 1;

  function initScanners() {
    if (prefersReducedMotion) {
      scannerTracks.forEach((track) => {
        const leds = track.querySelectorAll('.scanner-led');
        const mid = Math.floor(leds.length / 2);
        leds[mid].setAttribute('data-intensity', '3');
        if (leds[mid - 1]) leds[mid - 1].setAttribute('data-intensity', '2');
        if (leds[mid + 1]) leds[mid + 1].setAttribute('data-intensity', '2');
        track.classList.add('active');
      });
      return;
    }

    scannerTracks.forEach((track) => {
      startScannerSweep(track);
      track.classList.add('active');
    });
  }

  function startScannerSweep(track) {
    const leds = track.querySelectorAll('.scanner-led');
    const isHero = !track.classList.contains('hero__scanner-track--bottom');
    let position = 0;
    let direction = 1;
    let paused = false;

    function step() {
      for (let i = 0; i < leds.length; i++) {
        leds[i].setAttribute('data-intensity', '0');
      }

      for (let t = 0; t < TRAIL_INTENSITIES.length; t++) {
        const idx = position - t * direction;
        if (idx >= 0 && idx < leds.length) {
          leds[idx].setAttribute('data-intensity', String(TRAIL_INTENSITIES[t]));
        }
      }

      position += direction;

      if (position >= leds.length) {
        position = leds.length - 1;
        direction = -1;
        paused = true;
      } else if (position < 0) {
        position = 0;
        direction = 1;
        paused = true;
      }

      const speed = isHero ? scannerSpeed : 1;
      const delay = paused
        ? BASE_STEP_MS * speed * 2.5
        : BASE_STEP_MS * speed;
      paused = false;

      setTimeout(step, delay);
    }

    step();
  }

  function flashScanners() {
    if (prefersReducedMotion) return;
    scannerTracks.forEach((track) => {
      const leds = track.querySelectorAll('.scanner-led');
      leds.forEach((led) => led.setAttribute('data-intensity', '5'));
      setTimeout(() => {
        leds.forEach((led) => led.setAttribute('data-intensity', '0'));
      }, 350);
    });
  }

  initScanners();

  // ============================================
  // BOOT SEQUENCE: Typewriter with CRT flicker
  // ============================================
  const taglineEl = document.querySelector('.hero__tagline');
  const taglineText = "You've told AI everything. It remembers nothing.";
  let charIndex = 0;

  function typeNextChar() {
    if (charIndex < taglineText.length) {
      taglineEl.textContent += taglineText[charIndex];
      charIndex++;

      if (!prefersReducedMotion && charIndex % 12 === 0) {
        taglineEl.style.opacity = '0.7';
        setTimeout(() => { taglineEl.style.opacity = '1'; }, 50);
      }

      const delay = taglineText[charIndex - 1] === '.' ? 320 : 42;
      setTimeout(typeNextChar, delay);
    } else {
      setTimeout(() => taglineEl.classList.add('done'), 2000);
    }
  }

  setTimeout(typeNextChar, 2000);

  // ============================================
  // SCROLL REVEAL (IntersectionObserver)
  // ============================================
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  document.querySelectorAll('.reveal').forEach((el) => {
    revealObserver.observe(el);
  });

  // ============================================
  // TERMINAL FADE + RECOVERY ANIMATION
  // Lines fade out (problem), then one comes
  // back with phosphor glow (K.Y.T. solution)
  // ============================================
  const terminalSection = document.getElementById('problem');
  const terminalLines = document.querySelectorAll('.terminal__line');
  const terminalRecovery = document.getElementById('terminal-recovery');
  let terminalTriggered = false;

  const terminalObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !terminalTriggered) {
          terminalTriggered = true;
          startTerminalFade();
          terminalObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.3 }
  );

  if (terminalSection) {
    terminalObserver.observe(terminalSection);
  }

  function startTerminalFade() {
    const lines = Array.from(terminalLines);
    let currentIndex = 0;

    function fadeNext() {
      if (currentIndex < lines.length) {
        lines[currentIndex].classList.add('fading');
        currentIndex++;
        setTimeout(fadeNext, 800);
      } else {
        // All lines faded — show recovery after pause
        setTimeout(showRecovery, 1200);
      }
    }

    function showRecovery() {
      if (terminalRecovery) {
        terminalRecovery.hidden = false;
      }
      // Hold the recovery visible, then reset cycle
      setTimeout(resetCycle, 3500);
    }

    function resetCycle() {
      if (terminalRecovery) {
        terminalRecovery.hidden = true;
      }
      lines.forEach((line) => line.classList.remove('fading'));
      currentIndex = 0;
      setTimeout(fadeNext, 1500);
    }

    setTimeout(fadeNext, 1000);
  }

  // ============================================
  // PLATFORM ICONS LIGHT-UP
  // ============================================
  const platformSection = document.getElementById('solution');
  const platforms = document.querySelectorAll('.platform');
  let platformsTriggered = false;

  const platformObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !platformsTriggered) {
          platformsTriggered = true;
          platforms.forEach((p, i) => {
            setTimeout(() => p.classList.add('lit'), 300 * (i + 1));
          });
          platformObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.2 }
  );

  if (platformSection) {
    platformObserver.observe(platformSection);
  }

  // ============================================
  // STEPS TIMELINE LINE FILL
  // ============================================
  const stepsSection = document.getElementById('how');
  const lineFill = document.querySelector('.steps__line-fill');

  if (stepsSection && lineFill) {
    const stepsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            lineFill.classList.add('active');
            stepsObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.3 }
    );
    stepsObserver.observe(stepsSection);
  }

  // ============================================
  // RECENCY SIGNAL
  // ============================================
  const recencyEl = document.getElementById('recency-minutes');
  if (recencyEl) {
    let minutes = Math.floor(Math.random() * 6) + 2;
    recencyEl.textContent = minutes;

    setInterval(() => {
      if (minutes >= 12 || Math.random() < 0.3) {
        minutes = Math.floor(Math.random() * 4) + 1;
      } else {
        minutes++;
      }
      recencyEl.textContent = minutes;
    }, 30000);
  }

  // ============================================
  // DEMO CARD TAB SWITCHING
  // ============================================
  const demoTabs = document.querySelectorAll('.demo-tab');
  const demoTechnical = document.getElementById('demo-technical');
  const demoDeeper = document.getElementById('demo-deeper');

  demoTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;

      demoTabs.forEach((t) => {
        t.classList.remove('demo-tab--active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('demo-tab--active');
      tab.setAttribute('aria-selected', 'true');

      if (target === 'technical') {
        demoTechnical.hidden = false;
        demoTechnical.classList.remove('demo-card--hidden');
        if (demoDeeper) {
          demoDeeper.hidden = true;
          demoDeeper.classList.add('demo-card--hidden');
        }
      } else {
        if (demoDeeper) {
          demoDeeper.hidden = false;
          demoDeeper.classList.remove('demo-card--hidden');
        }
        demoTechnical.hidden = true;
        demoTechnical.classList.add('demo-card--hidden');
      }
    });
  });

  // ============================================
  // SCROLL PEEK (Zeigarnik)
  // ============================================
  if (!prefersReducedMotion) {
    const problemHeading = document.querySelector('#problem .section__heading');
    if (problemHeading) {
      const peekObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              problemHeading.style.opacity = '1';
              problemHeading.style.transform = 'translateY(0)';
            }
          });
        },
        { threshold: 0.05, rootMargin: '0px 0px 60px 0px' }
      );
      peekObserver.observe(problemHeading);
    }
  }

  // ============================================
  // SCANNER SCROLL PARALLAX
  // ============================================
  if (!prefersReducedMotion) {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scrollY = window.scrollY;
          const vh = window.innerHeight;
          const scrollRatio = Math.min(scrollY / (vh * 2), 1);
          scannerSpeed = 1 + scrollRatio * 2;
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  // ============================================
  // EXIT INTENT MODAL
  // ============================================
  const exitModal = document.getElementById('exit-modal');
  let exitShown = false;

  if (exitModal) {
    const closeBtn = exitModal.querySelector('.exit-modal__close');
    const backdrop = exitModal.querySelector('.exit-modal__backdrop');

    function showExitModal() {
      if (exitShown) return;
      exitShown = true;
      exitModal.hidden = false;
    }

    function hideExitModal() {
      exitModal.hidden = true;
    }

    document.addEventListener('mouseout', (e) => {
      if (e.clientY <= 0 && !exitShown) {
        showExitModal();
      }
    });

    closeBtn.addEventListener('click', hideExitModal);
    backdrop.addEventListener('click', hideExitModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !exitModal.hidden) {
        hideExitModal();
      }
    });
  }

  // ============================================
  // EMAIL FORM SUBMISSION
  // ============================================
  function getFormSource(form) {
    const id = form.id || '';
    if (id.includes('hero')) return 'hero';
    if (id.includes('exit')) return 'exit-intent';
    return 'cta';
  }

  function getUtmParams() {
    const p = new URLSearchParams(window.location.search);
    return {
      utm_source: p.get('utm_source'),
      utm_medium: p.get('utm_medium'),
      utm_campaign: p.get('utm_campaign'),
      utm_content: p.get('utm_content'),
      utm_term: p.get('utm_term'),
    };
  }

  document.querySelectorAll('.cta-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const input = form.querySelector('.cta-form__input');
      const btn = form.querySelector('.cta-form__btn');
      const btnText = btn.querySelector('.cta-form__btn-text');
      const hint = form.querySelector('.cta-form__hint');
      const success = form.querySelector('.cta-form__success');
      const email = input.value.trim();

      if (!email) return;

      btn.disabled = true;
      if (btnText) btnText.textContent = 'Joining...';

      try {
        const honeypot = form.querySelector('.cta-form__honeypot');
        const res = await fetch(
          'https://svrcvfzlwhnixzuxaccf.supabase.co/functions/v1/waitlist_capture',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              source: getFormSource(form),
              website: honeypot?.value || '',
              referrer: document.referrer || null,
              ...getUtmParams(),
            }),
          }
        );
        if (!res.ok) throw new Error('HTTP ' + res.status);

        input.value = '';
        if (hint) hint.hidden = true;
        success.hidden = false;
        if (btnText) btnText.textContent = "You're in";

        flashScanners();
      } catch (err) {
        if (btnText) btnText.textContent = 'Try again';
        btn.disabled = false;
        console.error('Waitlist submission failed:', err);
      }
    });
  });
})();

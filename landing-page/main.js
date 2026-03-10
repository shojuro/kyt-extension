/* ============================================
   K.Y.T. LANDING PAGE — main.js
   Boot sequence, scroll reveals, interactions
   K.I.T.T. segmented scanner engine
   ============================================ */

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ============================================
  // K.I.T.T. SCANNER ENGINE
  // 8-segment LED sweep with halogen trailing glow
  // ============================================
  const LED_COUNT = 8;
  // Intensity levels for the leading light and its trail
  // Index 0 = leading edge (brightest), then decay
  const TRAIL_INTENSITIES = [5, 4, 3, 2, 1];
  const BASE_STEP_MS = 120; // ms per LED step (base speed)

  const scannerTracks = document.querySelectorAll('.hero__scanner-track');
  let scannerSpeed = 1; // 1 = normal, higher = slower

  function initScanners() {
    if (prefersReducedMotion) {
      // Static center glow for reduced motion
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
    let direction = 1; // 1 = right, -1 = left
    let paused = false;

    function step() {
      // Clear all LEDs
      for (let i = 0; i < leds.length; i++) {
        leds[i].setAttribute('data-intensity', '0');
      }

      // Set leading light and trail
      for (let t = 0; t < TRAIL_INTENSITIES.length; t++) {
        const idx = position - t * direction;
        if (idx >= 0 && idx < leds.length) {
          leds[idx].setAttribute('data-intensity', String(TRAIL_INTENSITIES[t]));
        }
      }

      // Advance position
      position += direction;

      // Bounce at edges with a slight pause
      if (position >= leds.length) {
        position = leds.length - 1;
        direction = -1;
        paused = true;
      } else if (position < 0) {
        position = 0;
        direction = 1;
        paused = true;
      }

      // Hero scanner slows on scroll; bottom scanner always runs at full speed
      const speed = isHero ? scannerSpeed : 1;
      const delay = paused
        ? BASE_STEP_MS * speed * 2.5 // Edge pause
        : BASE_STEP_MS * speed;
      paused = false;

      setTimeout(step, delay);
    }

    step();
  }

  // Flash all LEDs (used on email submit)
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

  // Start scanners on load
  initScanners();

  // --- BOOT SEQUENCE: Typewriter ---
  const taglineEl = document.querySelector('.hero__tagline');
  const taglineText = "You've told AI everything. It remembers nothing.";
  let charIndex = 0;

  function typeNextChar() {
    if (charIndex < taglineText.length) {
      taglineEl.textContent += taglineText[charIndex];
      charIndex++;
      const delay = taglineText[charIndex - 1] === '.' ? 280 : 45;
      setTimeout(typeNextChar, delay);
    } else {
      setTimeout(() => taglineEl.classList.add('done'), 2000);
    }
  }

  setTimeout(typeNextChar, 2000);

  // --- SCROLL REVEAL (IntersectionObserver) ---
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

  // --- TERMINAL FADE ANIMATION ---
  const terminalSection = document.getElementById('problem');
  const terminalLines = document.querySelectorAll('.terminal__line');
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
        setTimeout(() => {
          lines.forEach((line) => line.classList.remove('fading'));
          currentIndex = 0;
          setTimeout(fadeNext, 1500);
        }, 2000);
      }
    }

    setTimeout(fadeNext, 1000);
  }

  // --- PLATFORM ICONS LIGHT-UP ---
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

  // --- STEPS TIMELINE LINE FILL ---
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

  // --- RECENCY SIGNAL (simulated "last signup" timer) ---
  const recencyEl = document.getElementById('recency-minutes');
  if (recencyEl) {
    // Start with a random believable number (2-7 min)
    let minutes = Math.floor(Math.random() * 6) + 2;
    recencyEl.textContent = minutes;

    setInterval(() => {
      // Randomly reset to low number (simulating new signups)
      if (minutes >= 12 || Math.random() < 0.3) {
        minutes = Math.floor(Math.random() * 4) + 1;
      } else {
        minutes++;
      }
      recencyEl.textContent = minutes;
    }, 30000); // Update every 30s
  }

  // --- DEMO CARD TAB SWITCHING ---
  const demoTabs = document.querySelectorAll('.demo-tab');
  const demoTechnical = document.getElementById('demo-technical');
  const demoEmotional = document.getElementById('demo-emotional');

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
        demoEmotional.hidden = true;
        demoEmotional.classList.add('demo-card--hidden');
      } else {
        demoEmotional.hidden = false;
        demoEmotional.classList.remove('demo-card--hidden');
        demoTechnical.hidden = true;
        demoTechnical.classList.add('demo-card--hidden');
      }
    });
  });

  // --- SCROLL PEEK (Zeigarnik — show problem headline at hero bottom) ---
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

  // --- SCANNER SCROLL PARALLAX (slow sweep on scroll) ---
  if (!prefersReducedMotion) {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scrollY = window.scrollY;
          const vh = window.innerHeight;
          const scrollRatio = Math.min(scrollY / (vh * 2), 1);
          // Slow scanner as user scrolls: 1x → 3x slower
          scannerSpeed = 1 + scrollRatio * 2;
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  // --- EXIT INTENT MODAL ---
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

    // Trigger on mouse leaving viewport top
    document.addEventListener('mouseout', (e) => {
      if (e.clientY <= 0 && !exitShown) {
        showExitModal();
      }
    });

    closeBtn.addEventListener('click', hideExitModal);
    backdrop.addEventListener('click', hideExitModal);

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !exitModal.hidden) {
        hideExitModal();
      }
    });
  }

  // --- EMAIL FORM SUBMISSION ---
  document.querySelectorAll('.cta-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const input = form.querySelector('.cta-form__input');
      const btn = form.querySelector('.cta-form__btn');
      const hint = form.querySelector('.cta-form__hint');
      const success = form.querySelector('.cta-form__success');
      const email = input.value.trim();

      if (!email) return;

      btn.disabled = true;
      btn.textContent = 'Joining...';

      try {
        // TODO: Replace with actual Supabase edge function endpoint
        // await fetch('https://your-project.supabase.co/functions/v1/waitlist', {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify({ email }),
        // });

        // Simulate for v1
        await new Promise((resolve) => setTimeout(resolve, 800));

        input.value = '';
        if (hint) hint.hidden = true;
        success.hidden = false;
        btn.textContent = "You're in";

        // Scanner flash on submit
        flashScanners();
      } catch (err) {
        btn.textContent = 'Try again';
        btn.disabled = false;
        console.error('Waitlist submission failed:', err);
      }
    });
  });
})();

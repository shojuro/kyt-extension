/* ============================================
   K.Y.T. FOUNDER'S DASHBOARD — founders.js
   Token-based access, tester signup
   ============================================ */

(function () {
  'use strict';

  const API_BASE = 'https://svrcvfzlwhnixzuxaccf.supabase.co/functions/v1';

  const loadingEl = document.getElementById('founder-loading');
  const errorEl = document.getElementById('founder-error');
  const dashboardEl = document.getElementById('founder-dashboard');
  const numberEl = document.getElementById('fd-number');
  const totalEl = document.getElementById('fd-total');
  const emailEl = document.getElementById('fd-email');
  const wantsTestEl = document.getElementById('fd-wants-test');
  const contactEl = document.getElementById('fd-contact');
  const saveBtnEl = document.getElementById('fd-save-btn');
  const saveSuccessEl = document.getElementById('fd-save-success');

  // Read token from URL
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  if (!token) {
    showError();
    return;
  }

  // Fetch founder info
  fetchFounderInfo();

  async function fetchFounderInfo() {
    try {
      const res = await fetch(API_BASE + '/get_founder_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        showError();
        return;
      }

      const data = await res.json();

      if (data.error) {
        showError();
        return;
      }

      showDashboard(data);
    } catch (err) {
      console.error('Failed to load founder info:', err);
      showError();
    }
  }

  function showError() {
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }

  function showDashboard(data) {
    loadingEl.hidden = true;
    dashboardEl.hidden = false;

    numberEl.textContent = data.founder_number;
    totalEl.textContent = data.total_founders;
    emailEl.textContent = data.email;

    if (data.wants_to_test) {
      wantsTestEl.checked = true;
    }
  }

  // Tester form save
  saveBtnEl.addEventListener('click', async () => {
    saveBtnEl.disabled = true;
    saveSuccessEl.hidden = true;

    try {
      const res = await fetch(API_BASE + '/get_founder_info', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          wants_to_test: wantsTestEl.checked,
          contact_info: contactEl.value.trim() || null,
        }),
      });

      if (res.ok) {
        saveSuccessEl.hidden = false;
      }
    } catch (err) {
      console.error('Failed to save tester info:', err);
    } finally {
      saveBtnEl.disabled = false;
    }
  });
})();

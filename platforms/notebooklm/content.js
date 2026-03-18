/**
 * KYT Memory Extension — NotebookLM Content Script (ISOLATED World)
 *
 * Purpose:
 *   1. Inject page-context script (inject.js) for Q&A auto-capture
 *   2. Relay captured messages to background.js via Queue Manager
 *   3. Inject "Send to K.Y.T." panel for manual report/artifact sending
 *
 * Architecture:
 *   inject.js (MAIN world) → KYT_MESSAGE_CAPTURED CustomEvent → this script (ISOLATED world)
 *     → Queue Manager → chrome.runtime → background.js
 *
 * Safety:
 *   - "Send to K.Y.T." panel uses Shadow DOM — page JS can't access it
 *   - Preview shown before send — user sees exactly what will be saved
 *   - Memory mode respected — incognito blocks all capture
 *   - chrome.runtime.id checked before all API calls
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // GENERATION GUARD
  // ═══════════════════════════════════════════════════════════════════════

  const GENERATION = Date.now();
  window.__kytNLMContentGeneration = GENERATION;

  function isCurrentGeneration() {
    return window.__kytNLMContentGeneration === GENERATION;
  }

  console.log('🚀 KYT NotebookLM Content: Initializing (generation ' + GENERATION + ')...');

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN WORLD SCRIPT INJECTION
  // ═══════════════════════════════════════════════════════════════════════

  const injectScript = document.createElement('script');
  injectScript.src = chrome.runtime.getURL('platforms/notebooklm/inject.js');
  injectScript.onload = function () {
    console.log('✅ KYT NLM Content: inject.js loaded');
    this.remove();
  };
  injectScript.onerror = function () {
    console.error('❌ KYT NLM Content: Failed to load inject.js');
  };
  (document.head || document.documentElement).appendChild(injectScript);

  // ═══════════════════════════════════════════════════════════════════════
  // QUEUE MANAGER
  // ═══════════════════════════════════════════════════════════════════════

  let queueManager = null;

  (async () => {
    try {
      const src = chrome.runtime.getURL('src/content/queue-manager.js');
      const module = await import(src);
      queueManager = module.queueManager;
      await queueManager.initialize(GENERATION);
      console.log('✅ KYT NLM Content: Queue Manager initialized');
    } catch (e) {
      console.error('❌ KYT NLM Content: Failed to load Queue Manager:', e.message);
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-CAPTURE — Q&A messages from inject.js
  // ═══════════════════════════════════════════════════════════════════════

  window.addEventListener('KYT_MESSAGE_CAPTURED', async function (event) {
    if (!isCurrentGeneration()) return;

    const data = event.detail;
    if (!data || !data.content) return;

    // Check extension context validity
    if (!chrome.runtime?.id) return;

    const messageData = {
      content: data.content,
      role: data.role || 'user',
      platform: 'notebooklm',
      source: data.captureMethod || 'api',
      conversationId: data.conversationId || null,
      timestamp: data.timestamp || Date.now(),
      messageId: data.messageId || null,
      url: data.url || window.location.href,
    };

    if (queueManager) {
      await queueManager.capture(messageData);
    } else if (chrome.runtime?.id) {
      chrome.runtime.sendMessage({
        type: 'SAVE_MESSAGE',
        data: messageData
      }).catch(() => { /* extension context may be invalid */ });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // "SEND TO K.Y.T." PANEL — Shadow DOM for isolation from page JS
  // ═══════════════════════════════════════════════════════════════════════

  let panelHost = null;
  let panelOpen = false;

  function createPanel() {
    if (panelHost) return;

    panelHost = document.createElement('div');
    panelHost.id = 'kyt-nlm-panel-host';
    const shadow = panelHost.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .kyt-fab {
          width: 48px; height: 48px; border-radius: 50%;
          background: #1a1a2e; border: 2px solid #e94560;
          color: #e94560; font-size: 20px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 12px rgba(233, 69, 96, 0.3);
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .kyt-fab:hover {
          transform: scale(1.1);
          box-shadow: 0 6px 20px rgba(233, 69, 96, 0.5);
        }
        .kyt-panel {
          display: none; position: absolute; bottom: 60px; right: 0;
          width: 340px; background: #1a1a2e; border: 1px solid #333;
          border-radius: 12px; padding: 16px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          color: #e0e0e0; font-size: 13px;
        }
        .kyt-panel.open { display: block; }
        .kyt-panel h3 {
          margin: 0 0 12px; font-size: 15px; color: #e94560;
          display: flex; align-items: center; gap: 8px;
        }
        .kyt-panel label { display: block; margin: 8px 0 4px; color: #aaa; font-size: 12px; }
        .kyt-panel select, .kyt-panel textarea {
          width: 100%; box-sizing: border-box;
          background: #0f0f23; border: 1px solid #333; color: #e0e0e0;
          border-radius: 6px; padding: 8px; font-size: 13px;
          font-family: inherit;
        }
        .kyt-panel select:focus, .kyt-panel textarea:focus {
          outline: none; border-color: #e94560;
        }
        .kyt-panel textarea { resize: vertical; min-height: 120px; max-height: 300px; }
        .kyt-preview {
          background: #0f0f23; border: 1px solid #222; border-radius: 6px;
          padding: 8px; margin: 8px 0; max-height: 200px; overflow-y: auto;
          font-size: 12px; line-height: 1.5; white-space: pre-wrap;
          color: #ccc;
        }
        .kyt-preview-meta {
          font-size: 11px; color: #888; margin-top: 4px;
        }
        .kyt-btn-row { display: flex; gap: 8px; margin-top: 12px; }
        .kyt-btn {
          flex: 1; padding: 8px 12px; border-radius: 6px; border: none;
          font-size: 13px; cursor: pointer; font-weight: 500;
          transition: background 0.15s;
        }
        .kyt-btn-send { background: #e94560; color: white; }
        .kyt-btn-send:hover { background: #ff6b81; }
        .kyt-btn-send:disabled { background: #555; cursor: not-allowed; }
        .kyt-btn-cancel { background: #333; color: #aaa; }
        .kyt-btn-cancel:hover { background: #444; }
        .kyt-status { font-size: 12px; margin-top: 8px; text-align: center; min-height: 18px; }
        .kyt-status.success { color: #4caf50; }
        .kyt-status.error { color: #e94560; }
        .kyt-scrape-btns { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
        .kyt-scrape-btn {
          padding: 4px 10px; border-radius: 4px; border: 1px solid #444;
          background: #0f0f23; color: #ccc; font-size: 11px; cursor: pointer;
        }
        .kyt-scrape-btn:hover { border-color: #e94560; color: #e94560; }
        .kyt-scrape-btn.active { border-color: #e94560; background: #e9456020; color: #e94560; }
      </style>

      <button class="kyt-fab" title="Send to K.Y.T.">K</button>

      <div class="kyt-panel">
        <h3>Send to K.Y.T.</h3>

        <label>Project</label>
        <select class="kyt-project-select">
          <option value="">Loading...</option>
        </select>

        <label>Content to send</label>
        <div class="kyt-scrape-btns"></div>

        <div class="kyt-preview"></div>
        <div class="kyt-preview-meta"></div>

        <div class="kyt-btn-row">
          <button class="kyt-btn kyt-btn-cancel">Cancel</button>
          <button class="kyt-btn kyt-btn-send" disabled>Send</button>
        </div>
        <div class="kyt-status"></div>
      </div>
    `;

    // Wire up events
    const fab = shadow.querySelector('.kyt-fab');
    const panel = shadow.querySelector('.kyt-panel');
    const projectSelect = shadow.querySelector('.kyt-project-select');
    const preview = shadow.querySelector('.kyt-preview');
    const previewMeta = shadow.querySelector('.kyt-preview-meta');
    const scrapeBtns = shadow.querySelector('.kyt-scrape-btns');
    const sendBtn = shadow.querySelector('.kyt-btn-send');
    const cancelBtn = shadow.querySelector('.kyt-btn-cancel');
    const statusEl = shadow.querySelector('.kyt-status');

    let selectedContent = '';
    let selectedType = '';

    fab.addEventListener('click', async () => {
      panelOpen = !panelOpen;
      panel.classList.toggle('open', panelOpen);
      if (panelOpen) {
        await loadProjects(projectSelect);
        detectArtifacts(scrapeBtns, preview, previewMeta, sendBtn);
        statusEl.textContent = '';
        statusEl.className = 'kyt-status';
      }
    });

    cancelBtn.addEventListener('click', () => {
      panelOpen = false;
      panel.classList.remove('open');
    });

    // Scrape button click handler — set via detectArtifacts
    scrapeBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.kyt-scrape-btn');
      if (!btn) return;

      // Deselect others
      scrapeBtns.querySelectorAll('.kyt-scrape-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const type = btn.dataset.type;
      const text = scrapeArtifact(type);
      selectedContent = text;
      selectedType = type;

      preview.textContent = text.slice(0, 2000) + (text.length > 2000 ? '\n\n[... truncated in preview]' : '');
      const words = text.split(/\s+/).length;
      previewMeta.textContent = words + ' words · ' + text.length + ' chars · type: ' + type;
      sendBtn.disabled = !text;
    });

    sendBtn.addEventListener('click', async () => {
      if (!selectedContent || !chrome.runtime?.id) return;

      const projectId = projectSelect.value;
      sendBtn.disabled = true;
      statusEl.textContent = 'Sending...';
      statusEl.className = 'kyt-status';

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'SAVE_MESSAGE',
          data: {
            content: selectedContent,
            role: 'assistant',
            platform: 'notebooklm',
            source: 'manual-send',
            conversationId: 'nlm-report-' + (getNotebookIdFromPath() || 'unknown'),
            timestamp: Date.now(),
            messageId: 'nlm_report_' + Date.now(),
            url: window.location.href,
            contentType: 'research',
            projectId: projectId || undefined,
          }
        });

        if (response?.success !== false) {
          statusEl.textContent = 'Saved to K.Y.T.';
          statusEl.className = 'kyt-status success';
          setTimeout(() => {
            panelOpen = false;
            panel.classList.remove('open');
          }, 1500);
        } else {
          statusEl.textContent = 'Error: ' + (response?.error || 'Unknown');
          statusEl.className = 'kyt-status error';
          sendBtn.disabled = false;
        }
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'kyt-status error';
        sendBtn.disabled = false;
      }
    });

    document.body.appendChild(panelHost);
  }

  function getNotebookIdFromPath() {
    const match = window.location.pathname.match(/\/notebook\/([^/]+)/);
    return match ? match[1] : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ARTIFACT DETECTION — Find reports/guides/FAQs in the NotebookLM DOM
  // ═══════════════════════════════════════════════════════════════════════

  // NotebookLM artifact selectors (these may change as Google updates the UI)
  const ARTIFACT_SELECTORS = {
    'study-guide': [
      '[data-artifact-type="study_guide"]',
      '.study-guide-container',
      '[aria-label*="Study Guide" i]',
    ],
    'briefing-doc': [
      '[data-artifact-type="briefing_doc"]',
      '.briefing-doc-container',
      '[aria-label*="Briefing" i]',
    ],
    'faq': [
      '[data-artifact-type="faq"]',
      '.faq-container',
      '[aria-label*="FAQ" i]',
    ],
    'timeline': [
      '[data-artifact-type="timeline"]',
      '.timeline-container',
      '[aria-label*="Timeline" i]',
    ],
    'chat-history': [
      '.chat-history',
      '.conversation-container',
      '[role="log"]',
    ],
    'selected-text': [], // Special: uses window.getSelection()
  };

  /**
   * Detect which artifacts are currently visible in the NotebookLM UI.
   * Creates buttons for each detected artifact type.
   */
  function detectArtifacts(container, preview, previewMeta, sendBtn) {
    container.innerHTML = '';
    preview.textContent = 'Select content to send';
    previewMeta.textContent = '';
    sendBtn.disabled = true;

    // Always offer selected text if there's a selection
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 10) {
      addScrapeButton(container, 'selected-text', 'Selected Text');
    }

    // Check for visible artifacts
    for (const [type, selectors] of Object.entries(ARTIFACT_SELECTORS)) {
      if (type === 'selected-text') continue;
      for (const selector of selectors) {
        try {
          const el = document.querySelector(selector);
          if (el && el.textContent.trim().length > 20) {
            const label = type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            addScrapeButton(container, type, label);
            break;
          }
        } catch { /* invalid selector */ }
      }
    }

    // Always offer "Visible Page" as fallback
    addScrapeButton(container, 'visible-page', 'Visible Page');
  }

  function addScrapeButton(container, type, label) {
    const btn = document.createElement('button');
    btn.className = 'kyt-scrape-btn';
    btn.dataset.type = type;
    btn.textContent = label;
    container.appendChild(btn);
  }

  /**
   * Scrape the content of a specific artifact type from the DOM.
   */
  function scrapeArtifact(type) {
    if (type === 'selected-text') {
      const selection = window.getSelection();
      return selection ? selection.toString().trim() : '';
    }

    if (type === 'visible-page') {
      return scrapeVisiblePage();
    }

    const selectors = ARTIFACT_SELECTORS[type] || [];
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const clone = el.cloneNode(true);
          // Strip UI buttons and actions
          clone.querySelectorAll('button, [role="button"], .action-bar, .toolbar').forEach(e => e.remove());
          const text = clone.innerText?.trim();
          if (text && text.length > 20) return text;
        }
      } catch { /* skip */ }
    }

    return '';
  }

  /**
   * Scrape the main visible content area as a fallback.
   */
  function scrapeVisiblePage() {
    // Try main content area first
    const mainSelectors = ['main', '[role="main"]', '.notebook-content', '.content-area'];
    for (const selector of mainSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('button, [role="button"], nav, header, footer, .toolbar, .sidebar, script, style').forEach(e => e.remove());
          const text = clone.innerText?.trim();
          if (text && text.length > 50) {
            // Truncate to avoid saving massive DOM dumps
            return text.slice(0, 100_000);
          }
        }
      } catch { /* skip */ }
    }

    // Last resort: document.body
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('button, nav, header, footer, script, style, .toolbar, .sidebar, #kyt-nlm-panel-host').forEach(e => e.remove());
    return (clone.innerText?.trim() || '').slice(0, 100_000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROJECT LIST — Fetch from background for the dropdown
  // ═══════════════════════════════════════════════════════════════════════

  async function loadProjects(selectEl) {
    if (!chrome.runtime?.id) return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'LIST_PROJECTS' });
      selectEl.innerHTML = '<option value="">(No project — save to general)</option>';

      if (response?.projects && Array.isArray(response.projects)) {
        for (const project of response.projects) {
          const option = document.createElement('option');
          option.value = project.id;
          option.textContent = project.name + (project.is_vault ? ' 🔒' : '');
          if (project.is_active) option.selected = true;
          selectEl.appendChild(option);
        }
      }
    } catch {
      selectEl.innerHTML = '<option value="">(Could not load projects)</option>';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZE — Wait for DOM ready, then create panel
  // ═══════════════════════════════════════════════════════════════════════

  function init() {
    // Only show panel on notebook pages, not the homepage
    if (!getNotebookIdFromPath()) {
      // Watch for URL changes (SPA navigation)
      let lastPath = window.location.pathname;
      const pathObserver = setInterval(() => {
        if (window.location.pathname !== lastPath) {
          lastPath = window.location.pathname;
          if (getNotebookIdFromPath() && !panelHost) {
            createPanel();
          }
        }
      }, 2000);
      return;
    }

    createPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATS HANDLER
  // ═══════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === 'GET_PAGE_STATS') {
      if (typeof window.__kytNotebookLMStats === 'function') {
        try {
          sendResponse({ success: true, stats: window.__kytNotebookLMStats() });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      } else {
        sendResponse({ success: false, error: 'Stats not available' });
      }
      return true;
    }
  });

  console.log('✅ KYT NotebookLM Content: Ready');
})();

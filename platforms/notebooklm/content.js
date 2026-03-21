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

        <label>Detected Artifacts</label>
        <div class="kyt-artifact-list" style="max-height:180px;overflow-y:auto;margin:4px 0;padding:4px;background:#0f0f23;border:1px solid #333;border-radius:6px"></div>
        <div class="kyt-quick-select" style="display:flex;gap:4px;margin:4px 0">
          <button class="kyt-scrape-btn" data-action="all">All</button>
          <button class="kyt-scrape-btn" data-action="none">None</button>
          <button class="kyt-scrape-btn" data-action="text">Text Only</button>
        </div>

        <label>Preview</label>
        <div class="kyt-preview"></div>
        <div class="kyt-preview-meta"></div>

        <div class="kyt-btn-row">
          <button class="kyt-btn kyt-btn-cancel">Cancel</button>
          <button class="kyt-btn kyt-btn-send" disabled>Send to K.Y.T.</button>
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
    const artifactList = shadow.querySelector('.kyt-artifact-list');
    const quickSelect = shadow.querySelector('.kyt-quick-select');
    const sendBtn = shadow.querySelector('.kyt-btn-send');
    const cancelBtn = shadow.querySelector('.kyt-btn-cancel');
    const statusEl = shadow.querySelector('.kyt-status');

    fab.addEventListener('click', async () => {
      panelOpen = !panelOpen;
      panel.classList.toggle('open', panelOpen);
      if (panelOpen) {
        await loadProjects(projectSelect);
        await populateArtifactList(artifactList, preview, previewMeta, sendBtn, sendBtn);
        statusEl.textContent = '';
        statusEl.className = 'kyt-status';
      }
    });

    cancelBtn.addEventListener('click', () => {
      panelOpen = false;
      panel.classList.remove('open');
    });

    // Quick select buttons (All / None / Text Only)
    quickSelect.addEventListener('click', (e) => {
      const action = e.target.dataset?.action;
      if (!action) return;

      const checkboxes = artifactList.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(cb => {
        const idx = parseInt(cb.dataset.index);
        const art = _detectedArtifacts[idx];
        if (action === 'all') {
          cb.checked = true;
          _selectedIndices.add(idx);
        } else if (action === 'none') {
          cb.checked = false;
          _selectedIndices.delete(idx);
        } else if (action === 'text') {
          const isText = art && (art.contentType === 'text' || art.contentType === 'interactive');
          cb.checked = isText;
          if (isText) _selectedIndices.add(idx); else _selectedIndices.delete(idx);
        }
      });
      updateSendButton(sendBtn, sendBtn);
      showPreviewForSelection(preview, previewMeta);
    });

    sendBtn.addEventListener('click', async () => {
      if (_selectedIndices.size === 0 || !chrome.runtime?.id) return;

      const projectId = projectSelect.value;
      sendBtn.disabled = true;

      await sendSelectedArtifacts(projectId, statusEl);

      // Auto-close after success
      if (statusEl.className.includes('success')) {
        setTimeout(() => {
          panelOpen = false;
          panel.classList.remove('open');
        }, 1500);
      } else {
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
  // ARTIFACT DETECTION + EXTRACTION (v2 — type-aware)
  // ═══════════════════════════════════════════════════════════════════════

  // These modules are loaded dynamically from web_accessible_resources
  let _artifactDetector = null;
  let _contentExtractors = null;

  async function loadArtifactModules() {
    if (!_artifactDetector) {
      try {
        const detectorSrc = chrome.runtime.getURL('platforms/notebooklm/artifact-detector.js');
        _artifactDetector = await import(detectorSrc);
      } catch (e) {
        console.warn('[KYT] Failed to load artifact-detector.js:', e.message);
      }
    }
    if (!_contentExtractors) {
      try {
        const extractorSrc = chrome.runtime.getURL('platforms/notebooklm/content-extractors.js');
        _contentExtractors = await import(extractorSrc);
      } catch (e) {
        console.warn('[KYT] Failed to load content-extractors.js:', e.message);
      }
    }
  }

  // Current detected artifacts (refreshed each time panel opens)
  let _detectedArtifacts = [];
  let _selectedIndices = new Set();

  /**
   * Detect artifacts and populate the panel checkbox list.
   */
  async function populateArtifactList(listContainer, preview, previewMeta, sendBtn, countEl) {
    await loadArtifactModules();

    listContainer.innerHTML = '';
    preview.textContent = 'Select artifacts to send';
    previewMeta.textContent = '';
    sendBtn.disabled = true;
    _selectedIndices.clear();

    if (_artifactDetector) {
      _detectedArtifacts = _artifactDetector.detectArtifacts();
    } else {
      // Fallback: basic detection without module
      _detectedArtifacts = [];
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 10) {
        _detectedArtifacts.push({
          type: 'selected-text', title: '✂️ Selected Text',
          artifactId: null, element: null, contentType: 'text', icon: '✂️',
        });
      }
      _detectedArtifacts.push({
        type: 'visible-page', title: '📄 Visible Page',
        artifactId: null, element: document.body, contentType: 'text', icon: '📄',
      });
    }

    if (_detectedArtifacts.length === 0) {
      listContainer.innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">No artifacts detected. Generate content in the Studio panel first.</div>';
      return;
    }

    // Create checkbox list
    for (let i = 0; i < _detectedArtifacts.length; i++) {
      const art = _detectedArtifacts[i];
      const row = document.createElement('label');
      row.className = 'kyt-artifact-row';
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;cursor:pointer;font-size:12px;';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.index = i;
      checkbox.checked = art.contentType === 'text' || art.contentType === 'interactive';
      if (checkbox.checked) _selectedIndices.add(i);

      const label = document.createElement('span');
      const metaTag = art.contentType === 'binary' ? ' <span style="color:#888;font-size:10px">(metadata)</span>' : '';
      label.innerHTML = `${art.icon} ${escapeHtml(art.title.substring(0, 50))}${metaTag}`;

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) _selectedIndices.add(i);
        else _selectedIndices.delete(i);
        updateSendButton(sendBtn, countEl);
        showPreviewForSelection(preview, previewMeta);
      });

      row.appendChild(checkbox);
      row.appendChild(label);
      listContainer.appendChild(row);
    }

    updateSendButton(sendBtn, countEl);
    showPreviewForSelection(preview, previewMeta);
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function updateSendButton(sendBtn, countEl) {
    const count = _selectedIndices.size;
    sendBtn.disabled = count === 0;
    if (countEl) countEl.textContent = count > 0 ? `Send ${count} to K.Y.T.` : 'Send to K.Y.T.';
  }

  function showPreviewForSelection(preview, previewMeta) {
    if (_selectedIndices.size === 0) {
      preview.textContent = 'Select artifacts to send';
      previewMeta.textContent = '';
      return;
    }

    // Show preview of the first selected artifact
    const firstIdx = [..._selectedIndices][0];
    const art = _detectedArtifacts[firstIdx];

    if (_contentExtractors && art.element) {
      const extracted = _contentExtractors.extractContent(art.type, art.element);
      preview.textContent = extracted.preview || 'No content extracted';
      const total = [..._selectedIndices].reduce((sum, idx) => {
        const a = _detectedArtifacts[idx];
        if (_contentExtractors && a.element) {
          return sum + _contentExtractors.extractContent(a.type, a.element).charCount;
        }
        return sum;
      }, 0);
      previewMeta.textContent = `${_selectedIndices.size} item(s) selected · ~${total.toLocaleString()} chars`;
    } else {
      preview.textContent = art.title;
      previewMeta.textContent = `${_selectedIndices.size} item(s) selected`;
    }
  }

  /**
   * Send all selected artifacts to K.Y.T.
   */
  async function sendSelectedArtifacts(projectId, statusEl) {
    const indices = [..._selectedIndices];
    if (indices.length === 0) return;

    let sent = 0;
    let failed = 0;

    for (const idx of indices) {
      const art = _detectedArtifacts[idx];
      statusEl.textContent = `Sending ${sent + 1}/${indices.length}...`;
      statusEl.className = 'kyt-status';

      try {
        let content = '';
        let isMetadata = false;

        if (art.type === 'visible-page') {
          content = scrapeVisiblePage();
        } else if (_contentExtractors && art.element) {
          const extracted = _contentExtractors.extractContent(art.type, art.element);
          content = extracted.content;
          isMetadata = extracted.isMetadata;
        } else if (art.type === 'selected-text') {
          content = window.getSelection()?.toString()?.trim() || '';
        } else {
          content = art.title + ' (no content extracted)';
          isMetadata = true;
        }

        if (!content) { failed++; continue; }

        const response = await chrome.runtime.sendMessage({
          type: 'SAVE_MESSAGE',
          data: {
            content: isMetadata ? `[NotebookLM Artifact Metadata]\n${content}` : content,
            role: 'assistant',
            platform: 'notebooklm',
            source: 'panel-send',
            conversationId: 'nlm-artifact-' + (getNotebookIdFromPath() || 'unknown'),
            timestamp: Date.now(),
            messageId: 'nlm_panel_' + Date.now() + '_' + idx,
            url: window.location.href,
            contentType: 'research',
            projectId: projectId || undefined,
            metadata: {
              artifactType: art.type,
              artifactId: art.artifactId,
              artifactTitle: art.title,
              isMetadata,
            },
          }
        });

        if (response?.success !== false) {
          sent++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    if (failed === 0) {
      statusEl.textContent = `Saved ${sent} item(s) to K.Y.T.`;
      statusEl.className = 'kyt-status success';
    } else {
      statusEl.textContent = `Saved ${sent}, failed ${failed}`;
      statusEl.className = 'kyt-status error';
    }
  }

  /**
   * Scrape the main visible content area as a fallback.
   */
  function scrapeVisiblePage() {
    const mainSelectors = ['main', '[role="main"]', '.notebook-content', '.content-area'];
    for (const selector of mainSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('button, [role="button"], nav, header, footer, .toolbar, .sidebar, script, style, #kyt-nlm-panel-host').forEach(e => e.remove());
          const text = clone.innerText?.trim();
          if (text && text.length > 50) return text.slice(0, 100_000);
        }
      } catch { /* skip */ }
    }
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

  // ═══════════════════════════════════════════════════════════════════════
  // RPC PROXY — Make batchexecute/streaming calls with full browser cookies
  // ═══════════════════════════════════════════════════════════════════════

  const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
  const STREAMING_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed';
  const NLM_ORIGIN = 'https://notebooklm.google.com';

  /**
   * Extract auth tokens from the page HTML + cookies.
   * CSRF (SNlM0e) and session ID (FdrFJe) are in script tags.
   * SAPISID is in document.cookie (not HttpOnly).
   */
  function extractAuthTokens() {
    const html = document.documentElement.innerHTML;
    const csrfMatch = html.match(/"SNlM0e"\s*:\s*"([^"]+)"/);
    const sessionMatch = html.match(/"FdrFJe"\s*:\s*"([^"]+)"/);
    const sapisidMatch = document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/);

    return {
      csrfToken: csrfMatch ? csrfMatch[1] : null,
      sessionId: sessionMatch ? sessionMatch[1] : null,
      sapisid: sapisidMatch ? sapisidMatch[1] : null,
    };
  }

  /**
   * Generate SAPISIDHASH for Authorization header.
   */
  function generateSapisidHash(sapisid) {
    // SHA-1 via SubtleCrypto is async — but we need sync for header building.
    // Use a simple approach: compute in the request flow.
    const timestamp = Math.floor(Date.now() / 1000);
    // We'll compute SHA-1 async and cache it
    return { timestamp, sapisid };
  }

  async function computeSha1(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Execute a batchexecute RPC call using the browser's full cookie jar.
   */
  async function executeRpcProxy(request) {
    const { type, methodId, encodedRpc, sourcePath, streamBody } = request;

    const auth = extractAuthTokens();
    if (!auth.csrfToken || !auth.sessionId) {
      return { success: false, error: 'Could not extract CSRF/session tokens from page' };
    }

    // Build SAPISIDHASH
    let authHeader = null;
    if (auth.sapisid) {
      const ts = Math.floor(Date.now() / 1000);
      const hash = await computeSha1(`${ts} ${auth.sapisid} ${NLM_ORIGIN}`);
      authHeader = `SAPISIDHASH ${ts}_${hash}`;
    }

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Origin': NLM_ORIGIN,
      'Referer': window.location.href || `${NLM_ORIGIN}/`,
    };
    if (authHeader) headers['Authorization'] = authHeader;

    try {
      if (type === 'streaming') {
        // Streaming request (askQuestion)
        const qs = new URLSearchParams({
          'hl': 'en',
          'f.sid': auth.sessionId,
          'rt': 'c',
        }).toString();

        const body = `f.req=${encodeURIComponent(streamBody)}&at=${encodeURIComponent(auth.csrfToken)}&`;

        const res = await fetch(`${STREAMING_URL}?${qs}`, {
          method: 'POST',
          headers,
          body,
          credentials: 'include',
        });

        if (!res.ok) {
          return { success: false, error: `HTTP ${res.status}`, status: res.status };
        }

        const responseText = await res.text();
        return { success: true, responseText, status: res.status };
      } else {
        // Standard batchexecute
        const qsParams = new URLSearchParams({
          'rpcids': methodId,
          'f.sid': auth.sessionId,
          'hl': 'en',
          'rt': 'c',
        });
        if (sourcePath) qsParams.set('source-path', sourcePath);

        const body = `f.req=${encodeURIComponent(encodedRpc)}&at=${encodeURIComponent(auth.csrfToken)}&`;

        const res = await fetch(`${BATCHEXECUTE_URL}?${qsParams.toString()}`, {
          method: 'POST',
          headers,
          body,
          credentials: 'include',
        });

        if (!res.ok) {
          return { success: false, error: `HTTP ${res.status}`, status: res.status };
        }

        const responseText = await res.text();
        return { success: true, responseText, status: res.status };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLER — Stats + RPC Proxy
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

    if (message.type === 'KYT_RPC_PROXY') {
      executeRpcProxy(message.request).then(result => {
        sendResponse(result);
      }).catch(err => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // async response
    }
  });

  console.log('✅ KYT NotebookLM Content: Ready');
})();

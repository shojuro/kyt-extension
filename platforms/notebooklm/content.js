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
        .kyt-artifact-list input[type="checkbox"] {
          accent-color: #e94560; flex-shrink: 0; margin: 0;
        }
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
  // ARTIFACT DETECTION + EXTRACTION (v3 — API-first with per-type dropdowns)
  // ═══════════════════════════════════════════════════════════════════════

  // Artifact type constants (matches notebooklm-constants.js)
  const ARTIFACT_TYPE_CODE = {
    1: 'audio', 2: 'report', 3: 'video', 4: 'quiz',
    5: 'mind_map', 7: 'infographic', 8: 'slide_deck', 9: 'data_table',
  };
  const ARTIFACT_STATUS_LABEL = { 1: 'processing', 2: 'pending', 3: 'completed', 4: 'failed' };
  const ARTIFACT_TYPE_ICONS = {
    audio: '🎧', video: '🎬', report: '📄', quiz: '❓',
    flashcards: '🃏', infographic: '📊', slide_deck: '📽️',
    data_table: '📋', mind_map: '🧠', note: '📝',
  };
  const ARTIFACT_CONTENT_TYPE = {
    audio: 'binary', video: 'binary', slide_deck: 'binary', infographic: 'binary',
    report: 'text', quiz: 'interactive', flashcards: 'interactive',
    data_table: 'text', mind_map: 'text', note: 'text',
  };

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

  /**
   * Fetch artifact list from NotebookLM API via batchexecute RPC.
   * Uses the content script's executeRpcProxy() which has full cookie access.
   *
   * @param {string} notebookId
   * @returns {Promise<Array<{id, title, type, typeLabel, contentType, icon, status, statusLabel}>>}
   */
  async function fetchArtifactList(notebookId) {
    const methodId = 'gArtLc';
    const params = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
    const encodedRpc = JSON.stringify([[[methodId, JSON.stringify(params), null, 'generic']]]);

    const result = await executeRpcProxy({
      type: 'batchexecute',
      methodId,
      encodedRpc,
      sourcePath: `/notebook/${notebookId}`,
    });

    if (!result.success) {
      console.warn('[KYT] list_artifacts RPC failed:', result.error);
      return null; // Signal to fall back to DOM detection
    }

    // Decode the batchexecute chunked response
    let responseText = result.responseText;
    if (responseText.startsWith(")]}'")) {
      responseText = responseText.slice(responseText.indexOf('\n') + 1);
    }

    // Parse chunked format to find wrb.fr frame
    const parsed = parseRpcResponse(responseText, methodId);
    if (!parsed || !Array.isArray(parsed)) return [];

    const artifacts = [];
    const entries = Array.isArray(parsed[0]) ? parsed[0] : parsed;

    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const id = typeof entry[0] === 'string' ? entry[0] : null;
      const title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';
      const typeCode = typeof entry[2] === 'number' ? entry[2] : null;
      const status = typeof entry[3] === 'number' ? entry[3] : null;

      if (id) {
        const typeName = ARTIFACT_TYPE_CODE[typeCode] || `type_${typeCode}`;
        artifacts.push({
          id,
          title,
          type: typeName,
          typeLabel: typeName.replace(/_/g, ' '),
          contentType: ARTIFACT_CONTENT_TYPE[typeName] || 'text',
          icon: ARTIFACT_TYPE_ICONS[typeName] || '📦',
          status,
          statusLabel: ARTIFACT_STATUS_LABEL[status] || `status_${status}`,
        });
      }
    }

    return artifacts;
  }

  /**
   * Fetch notes and mind maps from NotebookLM API via batchexecute RPC.
   * Notes carry their full content directly — no separate download step needed.
   *
   * @param {string} notebookId
   * @returns {Promise<Array<{id, title, content, type, contentType, icon, source}>>}
   */
  async function fetchNotesList(notebookId) {
    const methodId = 'cFji9';
    const params = [notebookId];
    const encodedRpc = JSON.stringify([[[methodId, JSON.stringify(params), null, 'generic']]]);

    const result = await executeRpcProxy({
      type: 'batchexecute',
      methodId,
      encodedRpc,
      sourcePath: `/notebook/${notebookId}`,
    });

    if (!result.success) {
      console.warn('[KYT] list_notes RPC failed:', result.error);
      return null;
    }

    let responseText = result.responseText;
    if (responseText.startsWith(")]}'")) {
      responseText = responseText.slice(responseText.indexOf('\n') + 1);
    }

    const parsed = parseRpcResponse(responseText, methodId);
    if (!parsed || !Array.isArray(parsed)) return [];

    const notes = [];
    const entries = Array.isArray(parsed[0]) ? parsed[0] : parsed;

    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const id = typeof entry[0] === 'string' ? entry[0] : null;
      if (!id) continue;

      // Skip deleted notes (status 2 at entry[2] when entry is short)
      if (entry.length <= 3 && entry[2] === 2) continue;

      // Entry format: [id, [title, content, ...], ...] or [id, title, content, ...]
      let title = 'Untitled';
      let contentStr = '';
      if (Array.isArray(entry[1])) {
        title = typeof entry[1][0] === 'string' ? entry[1][0] : 'Untitled';
        contentStr = typeof entry[1][1] === 'string' ? entry[1][1] : '';
      } else {
        title = typeof entry[1] === 'string' ? entry[1] : 'Untitled';
        contentStr = typeof entry[2] === 'string' ? entry[2] : '';
      }

      // Detect mind maps by checking if content is JSON with children/nodes
      let isMindMap = false;
      if (contentStr) {
        try {
          const obj = JSON.parse(contentStr);
          if (obj.children || obj.nodes) isMindMap = true;
        } catch { /* not JSON — regular note */ }
      }

      notes.push({
        id,
        title,
        content: contentStr,
        type: isMindMap ? 'mind_map' : 'note',
        contentType: 'text',
        icon: isMindMap ? '🧠' : '📝',
        source: 'api',
      });
    }

    return notes;
  }

  /**
   * Extract human-readable text from artifact RPC result data.
   * Walks nested arrays to find the longest meaningful string, strips HTML.
   */
  function extractTextFromArtifactData(data) {
    if (!data) return null;

    if (typeof data === 'string') {
      if (data.includes('<') && data.includes('>')) {
        return data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      return data;
    }

    if (Array.isArray(data)) {
      let longest = '';
      function walk(obj, depth) {
        if (depth > 8) return;
        if (typeof obj === 'string' && obj.length > longest.length && obj.length > 20) {
          longest = obj;
        }
        if (Array.isArray(obj)) {
          for (const item of obj) walk(item, depth + 1);
        }
      }
      walk(data, 0);

      if (longest.length > 20) {
        if (longest.includes('<') && longest.includes('>')) {
          return longest.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return longest;
      }
    }

    try {
      const json = JSON.stringify(data, null, 2);
      if (json.length > 20) return json;
    } catch { /* skip */ }

    return null;
  }

  /**
   * Parse batchexecute chunked response to extract the wrb.fr data.
   */
  function parseRpcResponse(text, methodId) {
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (/^\d+$/.test(line)) {
        i++;
        const jsonLines = [];
        while (i < lines.length) {
          const next = lines[i].trim();
          if (/^\d+$/.test(next) && jsonLines.length > 0) break;
          if (next) jsonLines.push(lines[i]);
          i++;
        }
        if (jsonLines.length > 0) {
          try {
            const chunk = JSON.parse(jsonLines.join('\n').trim());
            if (!Array.isArray(chunk)) continue;
            for (const item of chunk) {
              if (!Array.isArray(item)) continue;
              if (item[0] === 'wrb.fr' && item[1] === methodId) {
                const resultData = item[2];
                if (resultData === null) return null;
                if (typeof resultData === 'string') {
                  try { return JSON.parse(resultData); } catch { return resultData; }
                }
                return resultData;
              }
            }
          } catch { /* skip unparseable chunk */ }
        }
      } else {
        i++;
      }
    }
    return null;
  }

  // Current detected artifacts (refreshed each time panel opens)
  let _detectedArtifacts = [];
  let _selectedIndices = new Set();
  // Track which type groups are expanded
  let _expandedGroups = new Set();

  /**
   * Detect artifacts via API first, DOM fallback, and populate grouped dropdowns.
   */
  async function populateArtifactList(listContainer, preview, previewMeta, sendBtn, countEl) {
    await loadArtifactModules();

    listContainer.innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">Loading artifacts & notes...</div>';
    preview.textContent = 'Select items to send';
    previewMeta.textContent = '';
    sendBtn.disabled = true;
    _selectedIndices.clear();

    const notebookId = getNotebookIdFromPath();
    _detectedArtifacts = [];

    if (notebookId) {
      // Fetch artifacts and notes in parallel — one failure doesn't block the other
      const [artResult, noteResult] = await Promise.allSettled([
        fetchArtifactList(notebookId),
        fetchNotesList(notebookId),
      ]);

      const apiArtifacts = artResult.status === 'fulfilled' ? artResult.value : null;
      const apiNotes = noteResult.status === 'fulfilled' ? noteResult.value : null;

      if (apiArtifacts && apiArtifacts.length > 0) {
        _detectedArtifacts = apiArtifacts.map(a => ({
          ...a,
          element: null,
          source: 'api',
        }));
      } else if (_artifactDetector) {
        // Fallback: DOM detection for artifacts only
        _detectedArtifacts = _artifactDetector.detectArtifacts().map(a => ({ ...a, source: 'dom' }));
      }

      // Append notes (already carry content from API)
      if (apiNotes && apiNotes.length > 0) {
        for (const note of apiNotes) {
          _detectedArtifacts.push({ ...note, element: null });
        }
      }
    } else {
      // No notebook ID — DOM-only fallback
      if (_artifactDetector) {
        _detectedArtifacts = _artifactDetector.detectArtifacts().map(a => ({ ...a, source: 'dom' }));
      }
    }

    // Always include selected text at the top if available
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 10) {
      _detectedArtifacts.unshift({
        type: 'selected-text',
        title: 'Selected Text (' + selection.toString().trim().length + ' chars)',
        artifactId: null, id: null, element: null,
        contentType: 'text', icon: '✂️', source: 'dom',
      });
    }

    if (_detectedArtifacts.length === 0) {
      listContainer.innerHTML = '<div style="color:#888;font-size:12px;padding:8px 0">No artifacts or notes found. Create content in the Studio panel first.</div>';
      return;
    }

    // Group by type
    const groups = {};
    for (let i = 0; i < _detectedArtifacts.length; i++) {
      const art = _detectedArtifacts[i];
      const groupKey = art.type;
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push({ art, index: i });
    }

    // Render grouped dropdowns
    listContainer.innerHTML = '';

    // Define display order
    const typeOrder = ['selected-text', 'note', 'mind_map', 'report', 'audio', 'video', 'quiz', 'flashcards', 'slide_deck', 'infographic', 'data_table'];
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      const ai = typeOrder.indexOf(a);
      const bi = typeOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const groupKey of sortedKeys) {
      const items = groups[groupKey];
      const icon = items[0].art.icon || '📦';
      const label = groupKey === 'selected-text' ? 'Selected Text'
        : groupKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const isText = items[0].art.contentType === 'text' || items[0].art.contentType === 'interactive';

      // Default: expand text groups, collapse binary groups
      if (!_expandedGroups.has('__initialized')) {
        if (isText || groupKey === 'selected-text') _expandedGroups.add(groupKey);
      }
      const expanded = _expandedGroups.has(groupKey);

      // Group header
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:4px;padding:5px 0 2px;cursor:pointer;font-size:12px;font-weight:600;color:#ccc;user-select:none;';
      header.innerHTML = `<span style="width:12px;text-align:center;font-size:10px">${expanded ? '▼' : '►'}</span> ${icon} ${escapeHtml(label)} <span style="color:#888;font-weight:400">(${items.length})</span>`;

      const itemContainer = document.createElement('div');
      itemContainer.style.cssText = `display:${expanded ? 'block' : 'none'};padding-left:16px;`;

      header.addEventListener('click', () => {
        const isNowExpanded = itemContainer.style.display === 'none';
        itemContainer.style.display = isNowExpanded ? 'block' : 'none';
        header.querySelector('span').textContent = isNowExpanded ? '▼' : '►';
        if (isNowExpanded) _expandedGroups.add(groupKey);
        else _expandedGroups.delete(groupKey);
      });

      // Individual artifact rows
      for (const { art, index } of items) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:12px;';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.index = index;
        // Pre-check text artifacts
        checkbox.checked = isText || art.type === 'selected-text';
        if (checkbox.checked) _selectedIndices.add(index);

        const titleSpan = document.createElement('span');
        titleSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
        const isBinary = art.contentType === 'binary';
        const metaTag = isBinary ? ' <span style="color:#888;font-size:10px">(metadata)</span>' : '';
        const statusTag = art.statusLabel && art.statusLabel !== 'completed'
          ? ` <span style="color:#f0ad4e;font-size:10px">(${escapeHtml(art.statusLabel)})</span>` : '';
        titleSpan.innerHTML = `${escapeHtml((art.title || art.type).substring(0, 60))}${metaTag}${statusTag}`;

        checkbox.addEventListener('change', () => {
          if (checkbox.checked) _selectedIndices.add(index);
          else _selectedIndices.delete(index);
          updateSendButton(sendBtn, countEl);
          showPreviewForSelection(preview, previewMeta);
        });

        row.appendChild(checkbox);
        row.appendChild(titleSpan);
        itemContainer.appendChild(row);
      }

      listContainer.appendChild(header);
      listContainer.appendChild(itemContainer);
    }

    _expandedGroups.add('__initialized');
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

    const selected = [..._selectedIndices].map(i => _detectedArtifacts[i]);
    const textCount = selected.filter(a => a.contentType === 'text' || a.contentType === 'interactive').length;
    const metaCount = selected.filter(a => a.contentType === 'binary').length;

    // Show titles of selected artifacts
    const titles = selected.slice(0, 3).map(a => a.title || a.type).join('\n');
    const more = selected.length > 3 ? `\n... and ${selected.length - 3} more` : '';
    preview.textContent = titles + more;

    const parts = [`${_selectedIndices.size} item(s) selected`];
    if (textCount > 0) parts.push(`${textCount} text`);
    if (metaCount > 0) parts.push(`${metaCount} meta`);
    previewMeta.textContent = parts.join(' · ');
  }

  /**
   * Send all selected artifacts to K.Y.T.
   * For API-sourced text artifacts without DOM elements, requests content
   * download via background.js (Python CLI fallback).
   */
  async function sendSelectedArtifacts(projectId, statusEl) {
    const indices = [..._selectedIndices];
    if (indices.length === 0) return;

    let sent = 0;
    let failed = 0;
    const notebookId = getNotebookIdFromPath() || 'unknown';

    for (const idx of indices) {
      const art = _detectedArtifacts[idx];
      statusEl.textContent = `Sending ${sent + 1}/${indices.length}...`;
      statusEl.className = 'kyt-status';

      try {
        let content = '';
        let isMetadata = false;

        if (art.type === 'selected-text') {
          // Selected text — always from DOM
          content = window.getSelection()?.toString()?.trim() || '';
        } else if (art.type === 'visible-page') {
          content = scrapeVisiblePage();
        } else if ((art.type === 'note' || art.type === 'mind_map') && art.content) {
          // Notes carry content from the list API — no download needed
          content = art.content;
        } else if (art.contentType === 'binary') {
          // Binary artifacts — always metadata only
          isMetadata = true;
          content = [
            `Type: ${art.typeLabel || art.type}`,
            `Title: ${art.title}`,
            `Status: ${art.statusLabel || 'unknown'}`,
            art.id ? `Artifact ID: ${art.id}` : null,
            `Notebook: ${notebookId}`,
          ].filter(Boolean).join('\n');
        } else if (art.source === 'api' && art.id && chrome.runtime?.id) {
          // API-sourced text artifact — direct RPC download (no background roundtrip)
          statusEl.textContent = `Downloading ${sent + 1}/${indices.length}: ${art.title.substring(0, 30)}...`;
          try {
            const methodId = 'v9rmvd';
            const params = [notebookId, art.id];
            const encodedRpc = JSON.stringify([[[methodId, JSON.stringify(params), null, 'generic']]]);
            const rpcResult = await executeRpcProxy({
              type: 'batchexecute', methodId, encodedRpc,
              sourcePath: `/notebook/${notebookId}`,
            });
            if (rpcResult.success && rpcResult.responseText) {
              let responseText = rpcResult.responseText;
              if (responseText.startsWith(")]}'")) {
                responseText = responseText.slice(responseText.indexOf('\n') + 1);
              }
              const parsed = parseRpcResponse(responseText, methodId);
              content = extractTextFromArtifactData(parsed);
            }
          } catch (dlErr) {
            console.warn('[KYT] Direct download error for', art.title, dlErr.message);
          }
          if (!content) {
            isMetadata = true;
            content = [
              `Type: ${art.typeLabel || art.type}`,
              `Title: ${art.title}`,
              `Status: ${art.statusLabel || 'unknown'}`,
              `Note: Content download failed`,
              art.id ? `Artifact ID: ${art.id}` : null,
            ].filter(Boolean).join('\n');
          }
        } else if (_contentExtractors && art.element) {
          // DOM-sourced artifact with element — extract from DOM
          const extracted = _contentExtractors.extractContent(art.type, art.element);
          content = extracted.content;
          isMetadata = extracted.isMetadata;
        } else {
          // Last resort — metadata only
          content = art.title + ' (no content extracted)';
          isMetadata = true;
        }

        if (!content) { failed++; continue; }

        // Sanitize content (strip injection patterns, control chars)
        const sanitize = _contentExtractors?.sanitize || (t => t);
        const MAX_LEN = 100_000;

        // Format: metadata header + sanitized body, capped at 100KB
        const typeLabel = art.typeLabel || art.type;
        const finalContent = isMetadata
          ? `[NotebookLM Artifact Metadata]\n${content}`
          : `[NotebookLM ${typeLabel}] ${art.title}\n---\n${sanitize(content)}`.slice(0, MAX_LEN);

        // Set content_type per item type: notes→'note', artifacts→'research'
        const itemContentType = (art.type === 'note' || art.type === 'mind_map') ? 'note' : 'research';

        const response = await chrome.runtime.sendMessage({
          type: 'SAVE_MESSAGE',
          data: {
            content: finalContent,
            role: 'assistant',
            platform: 'notebooklm',
            source: 'panel-send',
            conversationId: 'nlm-artifact-' + notebookId,
            timestamp: Date.now(),
            messageId: 'nlm_panel_' + Date.now() + '_' + idx,
            url: window.location.href,
            contentType: itemContentType,
            projectId: projectId || undefined,
            metadata: {
              artifactType: art.type,
              artifactId: art.id || art.artifactId || null,
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
        // Extract current build label from page HTML (changes with Google deploys)
        const html = document.documentElement.innerHTML;
        const blMatch = html.match(/"cfb2h"\s*:\s*"([^"]+)"/);
        const bl = blMatch ? blMatch[1] : 'boq_labs-tailwind-frontend_20260329.03_p0';

        const qs = new URLSearchParams({
          'bl': bl,
          'f.sid': auth.sessionId,
          'hl': 'en',
          '_reqid': String(Math.floor(Math.random() * 9000000) + 1000000),
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
      } else if (type === 'fetch_url') {
        // Authenticated URL fetch — download binary artifacts using browser cookies
        const { url } = request;

        // Validate URL domain — only allow trusted Google domains
        let parsed;
        try { parsed = new URL(url); } catch { return { success: false, error: 'Invalid URL' }; }
        const trusted = ['.google.com', '.googleusercontent.com', '.googleapis.com'];
        if (parsed.protocol !== 'https:' || !trusted.some(d => parsed.hostname === d.slice(1) || parsed.hostname.endsWith(d))) {
          return { success: false, error: `Untrusted download domain: ${parsed.hostname}` };
        }

        const fetchHeaders = {};
        if (authHeader) fetchHeaders['Authorization'] = authHeader;

        const res = await fetch(url, {
          credentials: 'include',
          headers: fetchHeaders,
        });

        if (!res.ok) {
          return { success: false, error: `HTTP ${res.status}`, status: res.status };
        }

        // Check for auth redirect (HTML instead of binary)
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
          return { success: false, error: 'Received HTML instead of media — auth may have expired' };
        }

        // Convert binary to base64 for text-based bridge transport
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        return {
          success: true,
          base64Data: base64,
          contentType,
          size: bytes.length,
        };
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

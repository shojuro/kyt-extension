import { parseZipExport } from '../src/history-import/zip-parser.js';
import { validateExportFile } from '../src/history-import/validation.js';

// State machine
const STATES = {
    WELCOME: 'welcome',
    MODE_SELECT: 'mode_select',
    PERMISSION: 'permission',
    PLATFORM_SELECT: 'platform_select',
    IMPORTING: 'importing',
    FALLBACK: 'fallback',
    COMPLETE: 'complete',
    ERROR: 'error'
};

let currentState = STATES.PLATFORM_SELECT;
let selectedPlatform = null;
let isImporting = false;
let completedPlatforms = new Set();
let fallbackPlatform = null;

const elements = {};

// ============================================
// K.I.T.T. SCANNER ENGINE (import progress)
// ============================================
const LED_COUNT = 8;
const TRAIL_INTENSITIES = [5, 4, 3, 2, 1];
const BASE_STEP_MS = 120;
let scannerTimer = null;

function startImportScanner() {
    const track = document.getElementById('importScanner');
    if (!track) return;

    const leds = track.querySelectorAll('.kyt-scanner-led');
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

        const delay = paused ? BASE_STEP_MS * 2.5 : BASE_STEP_MS;
        paused = false;
        scannerTimer = setTimeout(step, delay);
    }

    step();
}

function stopImportScanner(flash) {
    if (scannerTimer) {
        clearTimeout(scannerTimer);
        scannerTimer = null;
    }

    const track = document.getElementById('importScanner');
    if (!track) return;

    const leds = track.querySelectorAll('.kyt-scanner-led');

    if (flash) {
        // Flash all LEDs on completion
        leds.forEach(led => led.setAttribute('data-intensity', '5'));
        setTimeout(() => {
            leds.forEach(led => led.setAttribute('data-intensity', '2'));
        }, 400);
    } else {
        leds.forEach(led => led.setAttribute('data-intensity', '0'));
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    setupListeners();
    checkFirstInstall();
});

function cacheElements() {
    elements.welcomeView = document.getElementById('welcome-view');
    elements.modeView = document.getElementById('mode-view');
    elements.permissionView = document.getElementById('permission-view');
    elements.mainView = document.getElementById('main-view');
    elements.fallbackView = document.getElementById('fallback-view');
    elements.btnWelcomeContinue = document.getElementById('btn-welcome-continue');
    elements.btnModeContinue = document.getElementById('btn-mode-continue');
    elements.btnAcceptImport = document.getElementById('btn-accept-import');
    elements.btnSkipImport = document.getElementById('btn-skip-import');
    elements.btnChatGPT = document.getElementById('btn-chatgpt');
    elements.btnClaude = document.getElementById('btn-claude');
    elements.btnGemini = document.getElementById('btn-gemini');
    elements.btnStart = document.getElementById('btn-start');
    elements.btnCancel = document.getElementById('btn-cancel');
    elements.btnBackToPlatforms = document.getElementById('btn-back-to-platforms');
    elements.progressContainer = document.getElementById('progress-container');
    elements.progressText = document.getElementById('progress-text');
    elements.progressCount = document.getElementById('progress-count');
    elements.errorMsg = document.getElementById('error-msg');
    elements.successMsg = document.getElementById('success-msg');
    elements.uploadZone = document.getElementById('upload-zone');
    elements.fileInput = document.getElementById('file-input');
    elements.fallbackReason = document.getElementById('fallback-reason');
    elements.exportInstructions = document.getElementById('export-instructions');
    elements.platformSelect = document.getElementById('platform-select');
    // Fallback view progress/status elements
    elements.fallbackHeading = document.getElementById('fallback-heading');
    elements.fallbackSubtext = document.getElementById('fallback-subtext');
    elements.fallbackProgressContainer = document.getElementById('fallback-progress-container');
    elements.fallbackProgressFill = document.getElementById('fallback-progress-fill');
    elements.fallbackProgressText = document.getElementById('fallback-progress-text');
    elements.fallbackProgressCount = document.getElementById('fallback-progress-count');
    elements.fallbackErrorMsg = document.getElementById('fallback-error-msg');
    elements.fallbackSuccessMsg = document.getElementById('fallback-success-msg');
}

let selectedMode = 'full';

function setupListeners() {
    // Welcome view → Mode selection
    elements.btnWelcomeContinue?.addEventListener('click', () => {
        setState(STATES.MODE_SELECT);
    });

    // Mode selection cards
    document.querySelectorAll('.mode-choice').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.mode-choice').forEach(c => {
                c.classList.remove('selected');
                c.style.borderColor = 'var(--border-subtle)';
            });
            card.classList.add('selected');
            card.style.borderColor = 'var(--scanner-red)';
            selectedMode = card.dataset.mode;
        });
    });

    // Mode view → Permission/import
    elements.btnModeContinue?.addEventListener('click', async () => {
        try {
            await chrome.runtime.sendMessage({
                type: 'SET_MEMORY_MODE',
                mode: selectedMode
            });
        } catch (e) {
            console.warn('Failed to set mode:', e);
        }
        setState(STATES.PERMISSION);
    });

    // Permission view buttons
    elements.btnAcceptImport?.addEventListener('click', () => {
        setState(STATES.PLATFORM_SELECT);
        markOnboardingSeen();
    });

    elements.btnSkipImport?.addEventListener('click', () => {
        markOnboardingSeen();
        window.close();
    });

    // Platform selection
    elements.btnChatGPT.addEventListener('click', () => selectPlatform('chatgpt'));
    elements.btnClaude.addEventListener('click', () => selectPlatform('claude'));
    elements.btnGemini.addEventListener('click', () => selectPlatform('gemini'));

    elements.btnStart.addEventListener('click', startImport);
    elements.btnCancel.addEventListener('click', () => {
        if (isImporting) {
            cancelImport();
        } else {
            window.close();
        }
    });

    // Back button from fallback view
    elements.btnBackToPlatforms?.addEventListener('click', () => {
        setState(STATES.PLATFORM_SELECT);
    });

    // ZIP upload handling
    setupUploadZone();

    // Listen for progress updates from background
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'IMPORT_PROGRESS') {
            updateProgress(message.progress);
        } else if (message.type === 'IMPORT_FALLBACK_REQUIRED') {
            showFallbackUI(message.platform, message.reason);
        }
    });
}

function setupUploadZone() {
    if (!elements.uploadZone || !elements.fileInput) return;

    elements.uploadZone.addEventListener('click', () => {
        elements.fileInput.click();
    });

    elements.uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.add('dragover');
    });

    elements.uploadZone.addEventListener('dragleave', () => {
        elements.uploadZone.classList.remove('dragover');
    });

    elements.uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.uploadZone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileUpload(files[0]);
        }
    });

    elements.fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });
}

/**
 * Get the active progress/status elements based on current view.
 * When in fallback view, use fallback-specific elements; otherwise use main-view ones.
 */
function getActiveUI() {
    if (currentState === STATES.FALLBACK) {
        return {
            progressContainer: elements.fallbackProgressContainer,
            progressFill: elements.fallbackProgressFill,
            progressText: elements.fallbackProgressText,
            progressCount: elements.fallbackProgressCount,
            errorMsg: elements.fallbackErrorMsg,
            successMsg: elements.fallbackSuccessMsg
        };
    }
    return {
        progressContainer: elements.progressContainer,
        progressFill: elements.progressFill,
        progressText: elements.progressText,
        progressCount: elements.progressCount,
        errorMsg: elements.errorMsg,
        successMsg: elements.successMsg
    };
}

async function handleFileUpload(file) {
    const platform = fallbackPlatform || selectedPlatform;
    if (!platform) {
        showError('No platform selected');
        return;
    }

    const ui = getActiveUI();

    try {
        ui.progressText.textContent = 'Validating file...';
        ui.progressContainer.style.display = 'block';
        ui.progressContainer.classList.remove('hidden');
        startImportScanner();

        const validation = await validateExportFile(file, platform);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        ui.progressText.textContent = 'Parsing ZIP file...';

        const messages = await parseZipExport(file, platform);

        if (!messages || messages.length === 0) {
            throw new Error('No messages found in export file');
        }

        ui.progressText.textContent = `Found ${messages.length} messages. Saving...`;

        const response = await chrome.runtime.sendMessage({
            type: 'PROCESS_IMPORTED_MESSAGES',
            platform,
            messages,
            source: 'zip_upload'
        });

        if (!response.success) {
            throw new Error(response.error || 'Failed to save messages');
        }

        // Success
        stopImportScanner(true);
        ui.progressText.textContent = 'Import complete!';
        completedPlatforms.add(platform);
        updatePlatformButtons();

        ui.successMsg.textContent = `Successfully imported ${messages.length} messages from ${platform}.`;
        ui.successMsg.style.display = 'block';

        setTimeout(() => {
            setState(STATES.PLATFORM_SELECT);
        }, 2000);

    } catch (e) {
        console.error('File upload error:', e);
        stopImportScanner(false);
        ui.errorMsg.textContent = e.message;
        ui.errorMsg.style.display = 'block';
        ui.progressContainer.style.display = 'none';
    }
}

async function checkFirstInstall() {
    const urlParams = new URLSearchParams(window.location.search);
    const isFirstInstall = urlParams.get('mode') === 'first-install';

    if (isFirstInstall) {
        const { show_import_onboarding } = await chrome.storage.local.get('show_import_onboarding');

        if (show_import_onboarding !== false) {
            setState(STATES.WELCOME);
            return;
        }
    }

    await loadCompletedPlatforms();
    setState(STATES.PLATFORM_SELECT);
}

async function loadCompletedPlatforms() {
    try {
        for (const platform of ['chatgpt', 'claude', 'gemini']) {
            const response = await chrome.runtime.sendMessage({
                type: 'CHECK_IMPORT_STATUS',
                platform
            });

            if (response.success && response.status?.hasCompletedImport) {
                completedPlatforms.add(platform);
            } else if (response.success && response.status?.hasInProgressImport) {
                // Resume showing import progress for the in-progress platform
                selectedPlatform = platform;
                isImporting = true;
                setState(STATES.IMPORTING);
                updateProgress(response.status.progress);
                return; // Skip PLATFORM_SELECT — show active import
            }
        }
        updatePlatformButtons();
    } catch (e) {
        console.error('Failed to load completed platforms:', e);
    }
}

async function markOnboardingSeen() {
    await chrome.storage.local.set({ show_import_onboarding: false });
}

function setState(newState) {
    currentState = newState;

    // Hide all views
    elements.welcomeView?.classList.add('hidden');
    elements.modeView?.classList.add('hidden');
    elements.permissionView?.classList.add('hidden');
    elements.mainView?.classList.add('hidden');
    elements.fallbackView?.classList.add('hidden');

    // Reset main-view messages
    elements.errorMsg.style.display = 'none';
    elements.successMsg.style.display = 'none';
    elements.progressContainer.style.display = 'none';
    stopImportScanner(false);

    // Reset fallback-view messages
    if (elements.fallbackErrorMsg) elements.fallbackErrorMsg.style.display = 'none';
    if (elements.fallbackSuccessMsg) elements.fallbackSuccessMsg.style.display = 'none';
    if (elements.fallbackProgressContainer) {
        elements.fallbackProgressContainer.style.display = 'none';
        elements.fallbackProgressContainer.classList.add('hidden');
    }

    switch (newState) {
        case STATES.WELCOME:
            elements.welcomeView?.classList.remove('hidden');
            break;

        case STATES.MODE_SELECT:
            elements.modeView?.classList.remove('hidden');
            // Pre-select full mode card
            const fullCard = document.getElementById('mode-full');
            if (fullCard) {
                fullCard.classList.add('selected');
                fullCard.style.borderColor = 'var(--scanner-red)';
            }
            break;

        case STATES.PERMISSION:
            elements.permissionView?.classList.remove('hidden');
            break;

        case STATES.PLATFORM_SELECT:
            elements.mainView?.classList.remove('hidden');
            isImporting = false;
            selectedPlatform = null;
            elements.btnStart.disabled = true;
            elements.btnStart.textContent = 'Start Import';
            updatePlatformButtons();
            break;

        case STATES.IMPORTING:
            elements.mainView?.classList.remove('hidden');
            elements.progressContainer.style.display = 'block';
            startImportScanner();
            break;

        case STATES.FALLBACK:
            elements.fallbackView?.classList.remove('hidden');
            break;

        case STATES.COMPLETE:
            elements.mainView?.classList.remove('hidden');
            elements.successMsg.style.display = 'block';
            break;

        case STATES.ERROR:
            elements.mainView?.classList.remove('hidden');
            elements.errorMsg.style.display = 'block';
            break;
    }
}

function updatePlatformButtons() {
    // ChatGPT button
    if (completedPlatforms.has('chatgpt')) {
        elements.btnChatGPT.textContent = 'ChatGPT \u2713';
        elements.btnChatGPT.classList.add('btn-complete');
        elements.btnChatGPT.classList.remove('btn-primary', 'btn-secondary');
    } else if (isImporting && selectedPlatform !== 'chatgpt') {
        elements.btnChatGPT.classList.add('btn-inactive');
    } else {
        elements.btnChatGPT.textContent = 'ChatGPT';
        elements.btnChatGPT.classList.remove('btn-complete', 'btn-inactive');
        elements.btnChatGPT.classList.toggle('btn-primary', selectedPlatform === 'chatgpt');
        elements.btnChatGPT.classList.toggle('btn-secondary', selectedPlatform !== 'chatgpt');
    }

    // Claude button
    if (completedPlatforms.has('claude')) {
        elements.btnClaude.textContent = 'Claude \u2713';
        elements.btnClaude.classList.add('btn-complete');
        elements.btnClaude.classList.remove('btn-primary', 'btn-secondary');
    } else if (isImporting && selectedPlatform !== 'claude') {
        elements.btnClaude.classList.add('btn-inactive');
    } else {
        elements.btnClaude.textContent = 'Claude';
        elements.btnClaude.classList.remove('btn-complete', 'btn-inactive');
        elements.btnClaude.classList.toggle('btn-primary', selectedPlatform === 'claude');
        elements.btnClaude.classList.toggle('btn-secondary', selectedPlatform !== 'claude');
    }

    // Gemini button
    if (completedPlatforms.has('gemini')) {
        elements.btnGemini.textContent = 'Gemini ✓';
        elements.btnGemini.classList.add('btn-complete');
        elements.btnGemini.classList.remove('btn-primary', 'btn-secondary');
    } else if (isImporting && selectedPlatform !== 'gemini') {
        elements.btnGemini.classList.add('btn-inactive');
    } else {
        elements.btnGemini.textContent = 'Gemini';
        elements.btnGemini.classList.remove('btn-complete', 'btn-inactive');
        elements.btnGemini.classList.toggle('btn-primary', selectedPlatform === 'gemini');
        elements.btnGemini.classList.toggle('btn-secondary', selectedPlatform !== 'gemini');
    }
}

function selectPlatform(platform) {
    if (isImporting) return;
    if (completedPlatforms.has(platform)) {
        // Allow re-import of completed platform
    }

    selectedPlatform = platform;
    updatePlatformButtons();

    // Gemini uses Google Takeout — go directly to file upload
    if (platform === 'gemini') {
        showGeminiUploadUI();
        return;
    }

    elements.btnStart.disabled = false;
    elements.errorMsg.style.display = 'none';
    elements.successMsg.style.display = 'none';

    checkStatus(platform);
}

/**
 * Show Google Takeout upload UI for Gemini.
 * This is the primary import path for Gemini (not a fallback).
 */
async function showGeminiUploadUI() {
    fallbackPlatform = 'gemini';

    // Positive framing — this is the primary path, not a fallback
    if (elements.fallbackHeading) {
        elements.fallbackHeading.textContent = 'Import from Google Takeout';
    }
    elements.fallbackReason.textContent =
        'Gemini imports use Google Takeout for accurate timestamps across your full conversation history.';
    if (elements.fallbackSubtext) {
        elements.fallbackSubtext.innerHTML = '<strong>Follow these steps:</strong>';
    }

    // Set Gemini-specific instructions
    elements.exportInstructions.innerHTML = getExportInstructions('gemini');

    setState(STATES.FALLBACK);

    // Check if Gemini was previously imported
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'CHECK_IMPORT_STATUS',
            platform: 'gemini'
        });
        if (response.success && response.status?.hasCompletedImport) {
            const ui = getActiveUI();
            ui.successMsg.textContent =
                `Previously imported on ${new Date(response.status.completedAt).toLocaleDateString()}. Upload again to update.`;
            ui.successMsg.style.display = 'block';
        }
    } catch (e) {
        // Not critical
    }
}

async function checkStatus(platform) {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'CHECK_IMPORT_STATUS',
            platform
        });

        if (response.success && response.status) {
            if (response.status.hasInProgressImport) {
                isImporting = true;
                elements.btnStart.disabled = true;
                elements.btnStart.textContent = 'Importing...';
                elements.progressContainer.style.display = 'block';
                startImportScanner();
                updateProgress(response.status.progress);
                updatePlatformButtons();
            } else if (response.status.hasCompletedImport) {
                elements.successMsg.textContent = `Import completed on ${new Date(response.status.completedAt).toLocaleDateString()}`;
                elements.successMsg.style.display = 'block';
                elements.btnStart.textContent = 'Re-import';
            }
        }
    } catch (e) {
        console.error('Failed to check status:', e);
    }
}

async function startImport() {
    if (!selectedPlatform) return;

    // Gemini uses Takeout upload, not live fetching
    if (selectedPlatform === 'gemini') {
        showGeminiUploadUI();
        return;
    }

    isImporting = true;
    elements.btnStart.disabled = true;
    elements.btnStart.textContent = 'Starting...';
    elements.errorMsg.style.display = 'none';
    elements.successMsg.style.display = 'none';
    elements.progressContainer.style.display = 'block';
    updatePlatformButtons();

    setState(STATES.IMPORTING);

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'START_HISTORY_IMPORT',
            platform: selectedPlatform
        });

        if (!response.success) {
            if (response.fallbackRequired) {
                showFallbackUI(selectedPlatform, response.error);
            } else {
                throw new Error(response.error);
            }
        }

    } catch (e) {
        showError(e.message);
        resetUI();
    }
}

function showFallbackUI(platform, reason) {
    fallbackPlatform = platform;

    // Restore warning framing for ChatGPT/Claude fallback
    if (elements.fallbackHeading) {
        elements.fallbackHeading.textContent = 'Automatic import unavailable';
    }
    if (elements.fallbackSubtext) {
        elements.fallbackSubtext.innerHTML = '<strong>You can still import via export file:</strong>';
    }

    const reasonMap = {
        'chatgpt': 'You\'re not logged into ChatGPT.',
        'claude': 'You\'re not logged into Claude.',
        'gemini': 'You\'re not logged into Gemini.'
    };
    elements.fallbackReason.textContent = reason || reasonMap[platform] || 'Automatic import unavailable.';

    const instructions = getExportInstructions(platform);
    elements.exportInstructions.innerHTML = instructions;

    setState(STATES.FALLBACK);
}

function getExportInstructions(platform) {
    if (platform === 'chatgpt') {
        return `
            <li>Go to <a href="https://chatgpt.com/" target="_blank">chatgpt.com</a></li>
            <li>Click your profile icon (bottom left) &rarr; Settings</li>
            <li>Go to Data Controls &rarr; Export data</li>
            <li>Click "Export" and wait for email</li>
            <li>Download the ZIP file and upload it here</li>
        `;
    } else if (platform === 'claude') {
        return `
            <li>Go to <a href="https://claude.ai/settings" target="_blank">claude.ai/settings</a></li>
            <li>Scroll to "Export Data"</li>
            <li>Click "Create Export" and wait</li>
            <li>Download the ZIP file when ready</li>
            <li>Upload the ZIP file here</li>
        `;
    } else if (platform === 'gemini') {
        return `
            <li>Go to <a href="https://takeout.google.com/" target="_blank">takeout.google.com</a></li>
            <li>Click <strong>"Deselect all"</strong> at the top</li>
            <li>Scroll down and check <strong>"Gemini Apps"</strong></li>
            <li>Click "Next step" → choose <strong>.zip</strong> format → "Create export"</li>
            <li>Wait for the email from Google (usually 5-30 minutes)</li>
            <li>Download the ZIP and upload it here</li>
        `;
    }
    return '';
}

async function cancelImport() {
    try {
        await chrome.runtime.sendMessage({
            type: 'CANCEL_HISTORY_IMPORT'
        });
        stopImportScanner(false);
        resetUI();
    } catch (e) {
        console.error('Failed to cancel:', e);
    }
}

function updateProgress(progress) {
    if (!progress) return;

    const percent = progress.conversationsTotal > 0
        ? Math.round((progress.conversationsProcessed / progress.conversationsTotal) * 100)
        : 0;

    elements.progressCount.textContent = `${progress.messagesImported} msgs`;

    if (progress.status === 'completed') {
        stopImportScanner(true);
        elements.progressText.textContent = 'Completed!';
        elements.successMsg.textContent = `Successfully imported ${progress.messagesImported} messages.`;
        elements.successMsg.style.display = 'block';
        completedPlatforms.add(progress.platform || selectedPlatform);
        resetUI(true);
    } else if (progress.status === 'failed') {
        stopImportScanner(false);
        if (progress.fallbackRequired) {
            showFallbackUI(progress.platform || selectedPlatform, progress.errorMessage);
        } else {
            showError(progress.errorMessage || 'Import failed');
            resetUI();
        }
    } else {
        elements.progressText.textContent = `Processing... (${percent}%)`;
    }
}

function showError(msg) {
    const ui = getActiveUI();
    ui.errorMsg.textContent = msg;
    ui.errorMsg.style.display = 'block';
}

function resetUI(completed = false) {
    isImporting = false;
    elements.btnStart.disabled = false;
    elements.btnStart.textContent = completed ? 'Re-import' : 'Start Import';
    updatePlatformButtons();

    if (!completed) {
        elements.progressContainer.style.display = 'none';
        stopImportScanner(false);
    }
}

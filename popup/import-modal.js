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

async function handleFileUpload(file) {
    const platform = fallbackPlatform || selectedPlatform;
    if (!platform) {
        showError('No platform selected');
        return;
    }

    try {
        elements.progressText.textContent = 'Validating file...';
        elements.progressContainer.style.display = 'block';
        startImportScanner();

        const validation = await validateExportFile(file, platform);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        elements.progressText.textContent = 'Parsing ZIP file...';

        const messages = await parseZipExport(file, platform);

        if (!messages || messages.length === 0) {
            throw new Error('No messages found in export file');
        }

        elements.progressText.textContent = `Found ${messages.length} messages. Saving...`;

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
        elements.progressText.textContent = 'Import complete!';
        completedPlatforms.add(platform);
        updatePlatformButtons();

        elements.successMsg.textContent = `Successfully imported ${messages.length} messages from ${platform}.`;
        elements.successMsg.style.display = 'block';

        setTimeout(() => {
            setState(STATES.PLATFORM_SELECT);
        }, 2000);

    } catch (e) {
        console.error('File upload error:', e);
        stopImportScanner(false);
        showError(e.message);
        elements.progressContainer.style.display = 'none';
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
        for (const platform of ['chatgpt', 'claude']) {
            const response = await chrome.runtime.sendMessage({
                type: 'CHECK_IMPORT_STATUS',
                platform
            });

            if (response.success && response.status?.hasCompletedImport) {
                completedPlatforms.add(platform);
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

    // Reset messages
    elements.errorMsg.style.display = 'none';
    elements.successMsg.style.display = 'none';
    elements.progressContainer.style.display = 'none';
    stopImportScanner(false);

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
}

function selectPlatform(platform) {
    if (isImporting) return;
    if (completedPlatforms.has(platform)) {
        // Allow re-import of completed platform
    }

    selectedPlatform = platform;
    updatePlatformButtons();

    elements.btnStart.disabled = false;
    elements.errorMsg.style.display = 'none';
    elements.successMsg.style.display = 'none';

    checkStatus(platform);
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

    const reasonMap = {
        'chatgpt': 'You\'re not logged into ChatGPT.',
        'claude': 'You\'re not logged into Claude.'
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
    elements.errorMsg.textContent = msg;
    elements.errorMsg.style.display = 'block';
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

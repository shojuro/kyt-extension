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

// Step mapping for step indicator
const STATE_STEPS = {
    [STATES.WELCOME]:         { current: 1, total: 3 },
    [STATES.MODE_SELECT]:     { current: 2, total: 3 },
    [STATES.PERMISSION]:      { current: 3, total: 3 },
    [STATES.PLATFORM_SELECT]: { current: 1, total: 3 },
    [STATES.IMPORTING]:       { current: 2, total: 3 },
    [STATES.COMPLETE]:        { current: 3, total: 3 },
    [STATES.FALLBACK]:        null,
    [STATES.ERROR]:           null
};

let currentState = STATES.PLATFORM_SELECT;
let selectedPlatform = null;
let isImporting = false;
let completedPlatforms = new Set();
let fallbackPlatform = null;

const elements = {};

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
    elements.progressFill = document.getElementById('progress-fill');
    elements.progressText = document.getElementById('progress-text');
    elements.progressCount = document.getElementById('progress-count');
    elements.errorMsg = document.getElementById('error-msg');
    elements.successMsg = document.getElementById('success-msg');
    elements.uploadZone = document.getElementById('upload-zone');
    elements.fileInput = document.getElementById('file-input');
    elements.fallbackReason = document.getElementById('fallback-reason');
    elements.exportInstructions = document.getElementById('export-instructions');
    elements.platformSelect = document.getElementById('platform-select');
    elements.kittScanner = document.getElementById('kitt-scanner');
    elements.completionBadge = document.getElementById('completion-badge');
    elements.mainStepIndicator = document.getElementById('main-step-indicator');
}

let selectedMode = 'full';

function setupListeners() {
    // Welcome view -> Mode selection
    elements.btnWelcomeContinue?.addEventListener('click', () => {
        setState(STATES.MODE_SELECT);
    });

    // Mode selection cards
    document.querySelectorAll('.mode-choice').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.mode-choice').forEach(c => {
                c.classList.remove('selected');
                c.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            });
            card.classList.add('selected');
            card.style.borderColor = '#FF66B2';
            selectedMode = card.dataset.mode;
        });
    });

    // Mode view -> Permission/import
    elements.btnModeContinue?.addEventListener('click', async () => {
        // Save the selected mode
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
        // Validate the file
        elements.progressText.textContent = 'Validating file...';
        elements.progressContainer.style.display = 'block';
        elements.progressFill.style.width = '10%';
        elements.progressFill.setAttribute('aria-valuenow', '10');

        const validation = await validateExportFile(file, platform);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // Parse the ZIP in popup (Option B - File API works here)
        elements.progressText.textContent = 'Parsing ZIP file...';
        elements.progressFill.style.width = '30%';
        elements.progressFill.setAttribute('aria-valuenow', '30');

        const messages = await parseZipExport(file, platform);

        if (!messages || messages.length === 0) {
            throw new Error('No messages found in export file');
        }

        elements.progressText.textContent = `Found ${messages.length} messages. Saving...`;
        elements.progressFill.style.width = '50%';
        elements.progressFill.setAttribute('aria-valuenow', '50');

        // Send parsed messages to background for saving
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
        elements.progressFill.style.width = '100%';
        elements.progressFill.setAttribute('aria-valuenow', '100');
        elements.progressText.textContent = 'Import complete!';
        completedPlatforms.add(platform);
        updatePlatformButtons();

        elements.successMsg.textContent = `Successfully imported ${messages.length} messages from ${platform}.`;
        elements.successMsg.style.display = 'block';

        // Return to platform select after delay
        setTimeout(() => {
            setState(STATES.PLATFORM_SELECT);
        }, 2000);

    } catch (e) {
        console.error('File upload error:', e);
        showError(e.message);
        elements.progressContainer.style.display = 'none';
    }
}

async function checkFirstInstall() {
    const urlParams = new URLSearchParams(window.location.search);
    const isFirstInstall = urlParams.get('mode') === 'first-install';

    if (isFirstInstall) {
        // Check if user has already seen onboarding
        const { show_import_onboarding } = await chrome.storage.local.get('show_import_onboarding');

        if (show_import_onboarding !== false) {
            setState(STATES.WELCOME);
            return;
        }
    }

    // Check for completed imports
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

function updateStepIndicator(state) {
    const step = STATE_STEPS[state];
    if (!step) return;

    // Update all step indicators in the active view
    const activeView = getActiveView(state);
    if (!activeView) return;

    const currentEls = activeView.querySelectorAll('.step-current');
    const totalEls = activeView.querySelectorAll('.step-total');
    currentEls.forEach(el => { el.textContent = step.current; });
    totalEls.forEach(el => { el.textContent = step.total; });
}

function getActiveView(state) {
    switch (state) {
        case STATES.WELCOME: return elements.welcomeView;
        case STATES.MODE_SELECT: return elements.modeView;
        case STATES.PERMISSION: return elements.permissionView;
        case STATES.PLATFORM_SELECT:
        case STATES.IMPORTING:
        case STATES.COMPLETE:
        case STATES.ERROR:
            return elements.mainView;
        case STATES.FALLBACK: return elements.fallbackView;
        default: return null;
    }
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
    elements.completionBadge?.classList.add('hidden');

    // Reset scanner
    if (elements.kittScanner) {
        elements.kittScanner.classList.remove('scanning', 'scan-complete');
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
                fullCard.style.borderColor = '#FF66B2';
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
            elements.btnStart.classList.remove('btn-secondary');
            elements.btnStart.classList.add('btn-primary');
            elements.btnCancel.textContent = 'Cancel';
            elements.btnCancel.classList.remove('btn-primary');
            elements.btnCancel.classList.add('btn-secondary');
            updatePlatformButtons();
            break;

        case STATES.IMPORTING:
            elements.mainView?.classList.remove('hidden');
            elements.progressContainer.style.display = 'block';
            // Start K.I.T.T. scanner
            if (elements.kittScanner) {
                elements.kittScanner.classList.add('scanning');
            }
            break;

        case STATES.FALLBACK:
            elements.fallbackView?.classList.remove('hidden');
            break;

        case STATES.COMPLETE:
            elements.mainView?.classList.remove('hidden');
            elements.progressContainer.style.display = 'block';
            elements.successMsg.style.display = 'block';
            // Scanner freeze -> gold
            if (elements.kittScanner) {
                elements.kittScanner.classList.add('scan-complete');
            }
            break;

        case STATES.ERROR:
            elements.mainView?.classList.remove('hidden');
            elements.errorMsg.style.display = 'block';
            break;
    }

    // Update step indicator for the new state
    updateStepIndicator(newState);
}

function updatePlatformButtons() {
    // ChatGPT button
    if (completedPlatforms.has('chatgpt')) {
        elements.btnChatGPT.innerHTML = 'ChatGPT <span class="checkmark-anim">&#10003;</span>';
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
        elements.btnClaude.innerHTML = 'Claude <span class="checkmark-anim">&#10003;</span>';
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

    // Check status
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
                if (elements.kittScanner) {
                    elements.kittScanner.classList.add('scanning');
                }
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

        // Success handled via progress updates

    } catch (e) {
        showError(e.message);
        resetUI();
    }
}

function showFallbackUI(platform, reason) {
    fallbackPlatform = platform;

    // Set reason text
    const reasonMap = {
        'chatgpt': 'You\'re not logged into ChatGPT.',
        'claude': 'You\'re not logged into Claude.'
    };
    elements.fallbackReason.textContent = reason || reasonMap[platform] || 'Automatic import unavailable.';

    // Set export instructions
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

    elements.progressFill.style.width = `${percent}%`;
    elements.progressFill.setAttribute('aria-valuenow', String(percent));
    elements.progressCount.textContent = `${progress.messagesImported} msgs`;

    if (progress.status === 'completed') {
        elements.progressFill.style.width = '100%';
        elements.progressFill.setAttribute('aria-valuenow', '100');
        elements.progressText.textContent = 'Your memories are secured.';
        elements.successMsg.textContent = `Successfully imported ${progress.messagesImported} messages.`;
        elements.successMsg.style.display = 'block';
        completedPlatforms.add(progress.platform || selectedPlatform);

        // Scanner -> gold complete
        if (elements.kittScanner) {
            elements.kittScanner.classList.remove('scanning');
            elements.kittScanner.classList.add('scan-complete');
        }

        // Show completion badge
        showCompletionBadge();

        // Delay before showing action buttons (let the moment land)
        setTimeout(() => {
            resetUI(true);
        }, 1500);
    } else if (progress.status === 'failed') {
        if (progress.fallbackRequired) {
            showFallbackUI(progress.platform || selectedPlatform, progress.errorMessage);
        } else {
            showError(progress.errorMessage || 'Import failed');
            resetUI();
        }
    } else {
        elements.progressText.textContent = `Remembering... (${percent}%)`;
    }
}

function showCompletionBadge() {
    if (!elements.completionBadge) return;
    elements.completionBadge.classList.remove('hidden');
    elements.completionBadge.innerHTML = `
        <div class="badge"></div>
        <span class="badge-label">Memories Secured</span>
    `;
}

function showError(msg) {
    elements.errorMsg.textContent = msg;
    elements.errorMsg.style.display = 'block';
}

function resetUI(completed = false) {
    isImporting = false;
    elements.btnStart.disabled = false;

    if (completed) {
        // "Close" is primary action, "Re-import" is secondary
        elements.btnStart.textContent = 'Re-import';
        elements.btnStart.classList.remove('btn-primary');
        elements.btnStart.classList.add('btn-secondary');
        elements.btnCancel.textContent = 'Close';
        elements.btnCancel.classList.remove('btn-secondary');
        elements.btnCancel.classList.add('btn-primary');
    } else {
        elements.btnStart.textContent = 'Start Import';
        elements.btnStart.classList.remove('btn-secondary');
        elements.btnStart.classList.add('btn-primary');
        elements.btnCancel.textContent = 'Cancel';
        elements.btnCancel.classList.remove('btn-primary');
        elements.btnCancel.classList.add('btn-secondary');
        elements.progressContainer.style.display = 'none';
        // Reset scanner
        if (elements.kittScanner) {
            elements.kittScanner.classList.remove('scanning', 'scan-complete');
        }
        // Hide badge
        elements.completionBadge?.classList.add('hidden');
    }

    updatePlatformButtons();
}

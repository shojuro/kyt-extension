let selectedPlatform = null;
let isImporting = false;

const elements = {
    btnChatGPT: document.getElementById('btn-chatgpt'),
    btnClaude: document.getElementById('btn-claude'),
    btnStart: document.getElementById('btn-start'),
    btnCancel: document.getElementById('btn-cancel'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    progressCount: document.getElementById('progress-count'),
    errorMsg: document.getElementById('error-msg'),
    successMsg: document.getElementById('success-msg')
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupListeners();
});

function setupListeners() {
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

    // Listen for progress updates from background
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'IMPORT_PROGRESS') {
            updateProgress(message.progress);
        }
    });
}

function selectPlatform(platform) {
    if (isImporting) return;

    selectedPlatform = platform;

    // Update UI
    elements.btnChatGPT.classList.toggle('btn-primary', platform === 'chatgpt');
    elements.btnChatGPT.classList.toggle('btn-secondary', platform !== 'chatgpt');

    elements.btnClaude.classList.toggle('btn-primary', platform === 'claude');
    elements.btnClaude.classList.toggle('btn-secondary', platform !== 'claude');

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
                updateProgress(response.status.progress);
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

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'START_HISTORY_IMPORT',
            platform: selectedPlatform
        });

        if (!response.success) {
            throw new Error(response.error);
        }

        // Success handled via progress updates

    } catch (e) {
        showError(e.message);
        resetUI();
    }
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
    elements.progressCount.textContent = `${progress.messagesImported} msgs`;

    if (progress.status === 'completed') {
        elements.progressText.textContent = 'Completed!';
        elements.successMsg.textContent = `Successfully imported ${progress.messagesImported} messages.`;
        elements.successMsg.style.display = 'block';
        resetUI(true);
    } else if (progress.status === 'failed') {
        showError(progress.errorMessage || 'Import failed');
        resetUI();
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

    if (!completed) {
        elements.progressContainer.style.display = 'none';
    }
}

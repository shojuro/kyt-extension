import JSZip from '../lib/jszip-wrapper.js';

/**
 * @typedef {import('./types.js').Platform} Platform
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string} [error]
 * @property {number} [fileSize]
 * @property {number} [estimatedMessages]
 */

const MAX_FILE_SIZE = 500 * 1024 * 1024;  // 500MB

/**
 * Validate export file
 * @param {File} file 
 * @param {Platform} platform 
 * @returns {Promise<ValidationResult>}
 */
export async function validateExportFile(file, platform) {
    // 1. Check file extension
    if (!file.name.toLowerCase().endsWith('.zip')) {
        return { valid: false, error: 'Please upload a ZIP file' };
    }

    // 2. Check file size
    if (file.size > MAX_FILE_SIZE) {
        return {
            valid: false,
            error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`
        };
    }

    if (file.size === 0) {
        return { valid: false, error: 'File is empty' };
    }

    // 3. Validate ZIP structure
    let zip;
    try {
        zip = await JSZip.loadAsync(file);
    } catch (e) {
        return { valid: false, error: 'Invalid ZIP file. The file may be corrupted.' };
    }

    // 4. Platform-specific validation
    if (platform === 'chatgpt') {
        return validateChatGPTExport(zip, file.size);
    } else {
        return validateClaudeExport(zip, file.size);
    }
}

/**
 * Validate ChatGPT export
 * @param {JSZip} zip 
 * @param {number} fileSize 
 * @returns {ValidationResult}
 */
function validateChatGPTExport(zip, fileSize) {
    const conversationsFile = zip.file('conversations.json');

    if (!conversationsFile) {
        // Check for common mistakes
        if (zip.file('chat.html')) {
            return {
                valid: false,
                error: 'This looks like a ChatGPT export, but conversations.json is missing. Please re-download your export.'
            };
        }
        return {
            valid: false,
            error: 'Not a valid ChatGPT export. Expected conversations.json file.'
        };
    }

    return {
        valid: true,
        fileSize,
        estimatedMessages: Math.floor(fileSize / 500)  // Rough estimate
    };
}

/**
 * Validate Claude export
 * @param {JSZip} zip 
 * @param {number} fileSize 
 * @returns {ValidationResult}
 */
function validateClaudeExport(zip, fileSize) {
    // Primary format: conversations.json at root (direct array)
    const rootFile = zip.file('conversations.json');
    if (rootFile) {
        return { valid: true, fileSize };
    }

    // Fallback: individual files in conversations/ folder
    const conversationsFolder = zip.folder('conversations');
    if (conversationsFolder) {
        let hasJsonFiles = false;
        conversationsFolder.forEach((path) => {
            if (path.endsWith('.json') && !path.includes('/')) {
                hasJsonFiles = true;
            }
        });

        if (hasJsonFiles) {
            return { valid: true, fileSize };
        }
    }

    return {
        valid: false,
        error: 'Not a valid Claude export. Expected conversations.json file.'
    };
}

/**
 * Sanitize content
 * @param {string} content 
 * @returns {string}
 */
export function sanitizeContent(content) {
    return content
        // Remove potential XSS
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        // Normalize unicode
        .normalize('NFC')
        // Remove null bytes
        .replace(/\0/g, '')
        // Trim whitespace
        .trim();
}

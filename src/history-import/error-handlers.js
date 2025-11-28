/**
 * @typedef {Object} ErrorHandler
 * @property {'prompt_reauth' | 'backoff' | 'retry' | 'save_progress_retry_later' | 'fail'} action
 * @property {string} [message]
 * @property {number} [delayMs]
 * @property {number} [maxRetries]
 * @property {number[]} [backoffMs]
 * @property {boolean} [fallbackToZip]
 */

/**
 * @typedef {Object} ErrorResolution
 * @property {boolean} shouldRetry
 * @property {number} [attempt]
 * @property {boolean} [requiresReauth]
 * @property {boolean} [saveProgress]
 * @property {string} [message]
 * @property {boolean} [fallbackToZip]
 */

/** @type {Record<number|string, ErrorHandler>} */
export const ERROR_HANDLERS = {
    // Authentication errors
    401: {
        action: 'prompt_reauth',
        message: 'Session expired. Please refresh the page and try again.',
        fallbackToZip: true
    },
    403: {
        action: 'prompt_reauth',
        message: 'Access denied. Please log in again.',
        fallbackToZip: true
    },

    // Rate limiting
    429: {
        action: 'backoff',
        delayMs: 60000,  // Wait 60 seconds
        maxRetries: 3,
        fallbackToZip: false
    },

    // Server errors
    500: {
        action: 'retry',
        maxRetries: 3,
        backoffMs: [1000, 2000, 4000],  // Exponential backoff
        fallbackToZip: true
    },
    502: {
        action: 'retry',
        maxRetries: 3,
        backoffMs: [1000, 2000, 4000],
        fallbackToZip: true
    },
    503: {
        action: 'retry',
        maxRetries: 3,
        backoffMs: [2000, 4000, 8000],
        fallbackToZip: true
    },

    // Network errors
    'network': {
        action: 'save_progress_retry_later',
        message: 'Network error. Progress saved. Will retry on next open.',
        fallbackToZip: true
    },

    // Unknown errors
    'default': {
        action: 'fail',
        message: 'An unexpected error occurred.',
        fallbackToZip: true
    }
};

/**
 * Handle API errors
 * @param {Error|Response} error 
 * @param {Object} context 
 * @param {string} [context.conversationId]
 * @param {number} [context.attempt]
 * @returns {Promise<ErrorResolution>}
 */
export async function handleError(error, context) {
    let statusCode;

    if (error instanceof Response) {
        statusCode = error.status;
    } else if (error.message && (error.message.includes('network') || error.message.includes('fetch'))) {
        statusCode = 'network';
    } else {
        statusCode = 'default';
    }

    const handler = ERROR_HANDLERS[statusCode] || ERROR_HANDLERS['default'];

    switch (handler.action) {
        case 'retry':
            const attempt = context.attempt || 0;
            if (attempt < (handler.maxRetries || 3)) {
                const delay = handler.backoffMs?.[attempt] || 1000 * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                return { shouldRetry: true, attempt: attempt + 1 };
            }
            return { shouldRetry: false, fallbackToZip: handler.fallbackToZip };

        case 'backoff':
            await new Promise(r => setTimeout(r, handler.delayMs || 60000));
            return { shouldRetry: true, attempt: 0 };

        case 'prompt_reauth':
            return {
                shouldRetry: false,
                requiresReauth: true,
                message: handler.message,
                fallbackToZip: handler.fallbackToZip
            };

        case 'save_progress_retry_later':
            return {
                shouldRetry: false,
                saveProgress: true,
                message: handler.message,
                fallbackToZip: handler.fallbackToZip
            };

        default:
            return {
                shouldRetry: false,
                message: handler.message,
                fallbackToZip: handler.fallbackToZip
            };
    }
}

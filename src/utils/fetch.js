/**
 * Fetch with timeout using AbortController.
 * Prevents hung requests from blocking the Chrome message channel or sync pipeline.
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Standard fetch options
 * @param {number} [timeoutMs=10000] - Timeout in milliseconds
 * @returns {Promise<Response>} Fetch response or throws on timeout
 */
export async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

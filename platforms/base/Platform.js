/**
 * KYT Memory Extension - Platform Base Class
 *
 * Abstract base class that all platform implementations must extend.
 * Defines the interface for platform-specific message capture.
 *
 * @abstract
 */
export class Platform {
  constructor() {
    if (new.target === Platform) {
      throw new TypeError("Cannot construct Platform instances directly - must extend Platform class");
    }
  }

  // ===================================================================
  // REQUIRED METHODS - Must be implemented by all platform subclasses
  // ===================================================================

  /**
   * Get the platform name (used for identification and logging)
   * @returns {string} Platform name (e.g., 'chatgpt', 'claude')
   */
  getName() {
    throw new Error(`${this.constructor.name} must implement getName()`);
  }

  /**
   * Get URL patterns this platform matches
   * Used for automatic platform detection
   * @returns {string[]} Array of URL patterns (e.g., ['chatgpt.com', 'chat.openai.com'])
   */
  getUrlPatterns() {
    throw new Error(`${this.constructor.name} must implement getUrlPatterns()`);
  }

  /**
   * Detect if a fetch call is an API call for this platform
   * @param {string} url - The URL being fetched
   * @param {Object} options - Fetch options (includes method, body, headers)
   * @returns {boolean} True if this is a platform API call to intercept
   */
  detectAPICall(url, options) {
    throw new Error(`${this.constructor.name} must implement detectAPICall(url, options)`);
  }

  /**
   * Extract message data from API request body
   * @param {string} requestBody - The request body string (usually JSON)
   * @returns {Object|null} Message data object or null if extraction fails
   *
   * Expected return format:
   * {
   *   content: string,           // The actual message text
   *   role: string,              // 'user', 'assistant', 'system'
   *   conversationId: string,    // Unique conversation identifier
   *   model: string,             // Model name (e.g., 'gpt-4', 'claude-3')
   *   timestamp: number,         // Unix timestamp
   *   messageId: string,         // Unique message identifier
   *   platform: string           // Platform name (from getName())
   * }
   */
  extractMessage(requestBody) {
    throw new Error(`${this.constructor.name} must implement extractMessage(requestBody)`);
  }

  // ===================================================================
  // OPTIONAL METHODS - Override to customize platform behavior
  // ===================================================================

  /**
   * Get the path to the injected script for this platform
   * @returns {string} Path to inject.js file
   */
  getInjectedScriptPath() {
    return `platforms/${this.getName()}/inject.js`;
  }

  /**
   * Get the path to the content script for this platform
   * @returns {string} Path to content.js file
   */
  getContentScriptPath() {
    return `platforms/${this.getName()}/content.js`;
  }

  /**
   * Get manifest.json overrides for this platform
   * These will be merged with the base manifest
   * @returns {Object} Manifest overrides
   */
  getManifestOverrides() {
    return {};
  }

  /**
   * Whether this platform supports context injection (RAG)
   * @returns {boolean} True if platform supports context injection
   */
  supportsContextInjection() {
    return true;
  }

  /**
   * Get the context injection strategy for this platform
   * @returns {string} 'prepend', 'system-message', or 'hidden'
   */
  getContextInjectionStrategy() {
    return 'prepend'; // Default: prepend context to user message
  }

  /**
   * Validate that the platform is properly configured
   * @returns {boolean} True if platform is valid
   * @throws {Error} If platform configuration is invalid
   */
  validate() {
    // Check required methods return correct types
    const name = this.getName();
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${this.constructor.name}.getName() must return non-empty string`);
    }

    const patterns = this.getUrlPatterns();
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`${this.constructor.name}.getUrlPatterns() must return non-empty array`);
    }

    return true;
  }

  /**
   * Get a human-readable description of this platform
   * @returns {string} Platform description
   */
  toString() {
    return `Platform(${this.getName()})`;
  }
}

/**
 * KYT Memory Extension - Platform Registry
 *
 * Central registry for all platform implementations.
 * Handles platform detection, lookup, and management.
 */

import { Platform } from './Platform.js';

/**
 * Singleton registry for platform implementations
 */
class PlatformRegistry {
  constructor() {
    this.platforms = new Map();
    this.urlPatternCache = new Map(); // Cache for faster URL lookups
  }

  /**
   * Register a new platform
   * @param {Platform} platform - Platform instance to register
   * @throws {TypeError} If platform is not a Platform instance
   * @throws {Error} If platform with same name already registered
   */
  register(platform) {
    if (!(platform instanceof Platform)) {
      throw new TypeError("Must register Platform instance");
    }

    // Validate platform before registering
    platform.validate();

    const name = platform.getName();
    if (this.platforms.has(name)) {
      throw new Error(`Platform '${name}' is already registered`);
    }

    this.platforms.set(name, platform);

    // Update URL pattern cache
    const patterns = platform.getUrlPatterns();
    patterns.forEach(pattern => {
      if (!this.urlPatternCache.has(pattern)) {
        this.urlPatternCache.set(pattern, []);
      }
      this.urlPatternCache.get(pattern).push(platform);
    });

    console.log(`✅ KYT Registry: Registered platform '${name}' with patterns:`, patterns);
  }

  /**
   * Unregister a platform (for testing/hot reload)
   * @param {string} name - Platform name to unregister
   * @returns {boolean} True if platform was unregistered
   */
  unregister(name) {
    const platform = this.platforms.get(name);
    if (!platform) {
      return false;
    }

    // Remove from URL pattern cache
    const patterns = platform.getUrlPatterns();
    patterns.forEach(pattern => {
      const platforms = this.urlPatternCache.get(pattern);
      if (platforms) {
        const index = platforms.indexOf(platform);
        if (index > -1) {
          platforms.splice(index, 1);
        }
        if (platforms.length === 0) {
          this.urlPatternCache.delete(pattern);
        }
      }
    });

    this.platforms.delete(name);
    console.log(`🗑️ KYT Registry: Unregistered platform '${name}'`);
    return true;
  }

  /**
   * Detect which platform matches the given URL
   * @param {string} url - URL to check
   * @returns {Platform|null} Matching platform or null
   */
  detectPlatform(url) {
    if (typeof url !== 'string') {
      return null;
    }

    // Fast path: Check URL pattern cache
    for (const [pattern, platforms] of this.urlPatternCache) {
      if (url.includes(pattern)) {
        // Multiple platforms might match same pattern
        // Return first match (platforms registered first have priority)
        return platforms[0];
      }
    }

    return null;
  }

  /**
   * Get platform by name
   * @param {string} name - Platform name
   * @returns {Platform|undefined} Platform instance or undefined
   */
  getPlatform(name) {
    return this.platforms.get(name);
  }

  /**
   * Get all registered platforms
   * @returns {Platform[]} Array of all registered platforms
   */
  getAllPlatforms() {
    return Array.from(this.platforms.values());
  }

  /**
   * Get all platform names
   * @returns {string[]} Array of platform names
   */
  getPlatformNames() {
    return Array.from(this.platforms.keys());
  }

  /**
   * Check if a platform is registered
   * @param {string} name - Platform name
   * @returns {boolean} True if platform is registered
   */
  has(name) {
    return this.platforms.has(name);
  }

  /**
   * Get the number of registered platforms
   * @returns {number} Number of platforms
   */
  size() {
    return this.platforms.size;
  }

  /**
   * Clear all registered platforms (for testing)
   */
  clear() {
    this.platforms.clear();
    this.urlPatternCache.clear();
    console.log('🗑️ KYT Registry: Cleared all platforms');
  }

  /**
   * Get registry statistics
   * @returns {Object} Registry stats
   */
  getStats() {
    const platforms = this.getAllPlatforms();
    return {
      totalPlatforms: platforms.length,
      platformNames: this.getPlatformNames(),
      urlPatterns: Array.from(this.urlPatternCache.keys()),
      supportsContextInjection: platforms.filter(p => p.supportsContextInjection()).length
    };
  }
}

// Export singleton instance
export const registry = new PlatformRegistry();

// Also export class for testing
export { PlatformRegistry };

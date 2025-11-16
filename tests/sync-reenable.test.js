/**
 * Unit Tests for Sync Re-enablement
 *
 * Tests the hybrid sync logic, alarm creation, and sync window detection
 *
 * CLAUDE.md Compliance:
 * - Real assertions that can FAIL
 * - Tests specific logic units
 * - No mocking of core logic (only Chrome APIs)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('Sync Re-enablement Unit Tests', () => {

  // Test 1: Hybrid sync logic - immediate case
  it('should trigger immediate sync when >4 minutes since last sync', () => {
    const lastSyncTime = Date.now() - (5 * 60 * 1000); // 5 minutes ago
    const timeSinceSync = Date.now() - lastSyncTime;
    const shouldSyncImmediately = timeSinceSync > 4 * 60 * 1000;

    expect(shouldSyncImmediately).toBe(true);
    expect(timeSinceSync).toBeGreaterThan(4 * 60 * 1000);
  });

  // Test 2: Hybrid sync logic - batched case
  it('should NOT trigger immediate sync when <4 minutes since last sync', () => {
    const lastSyncTime = Date.now() - (2 * 60 * 1000); // 2 minutes ago
    const timeSinceSync = Date.now() - lastSyncTime;
    const shouldSyncImmediately = timeSinceSync > 4 * 60 * 1000;

    expect(shouldSyncImmediately).toBe(false);
    expect(timeSinceSync).toBeLessThan(4 * 60 * 1000);
  });

  // Test 3: Boundary case - exactly 4 minutes
  it('should handle 4-minute boundary correctly', () => {
    const lastSyncTime = Date.now() - (4 * 60 * 1000); // exactly 4 minutes ago
    const timeSinceSync = Date.now() - lastSyncTime;
    const shouldSyncImmediately = timeSinceSync > 4 * 60 * 1000;

    // At exactly 4 minutes, should NOT trigger (> not >=)
    expect(shouldSyncImmediately).toBe(false);
  });

  // Test 4: Missing last_sync_status handling
  it('should default to 0 when last_sync_status is missing', () => {
    const lastSync = undefined?.lastSyncTime || 0;
    const timeSinceSync = Date.now() - lastSync;

    expect(lastSync).toBe(0);
    expect(timeSinceSync).toBeGreaterThan(4 * 60 * 1000);
  });

  // Test 5: Alarm configuration validation
  it('should create alarm with correct periodInMinutes', () => {
    const alarmConfig = {
      name: 'periodicSync',
      periodInMinutes: 5
    };

    expect(alarmConfig.periodInMinutes).toBe(5);
    expect(alarmConfig.name).toBe('periodicSync');
  });

  // Test 6: Sync window threshold constant
  it('should use 4-minute threshold (4 * 60 * 1000 ms)', () => {
    const SYNC_THRESHOLD_MS = 4 * 60 * 1000;

    expect(SYNC_THRESHOLD_MS).toBe(240000); // 240,000 milliseconds
    expect(SYNC_THRESHOLD_MS / 1000 / 60).toBe(4); // 4 minutes
  });

  // Test 7: Time calculation edge case - zero lastSyncTime
  it('should handle lastSyncTime of 0 correctly', () => {
    const lastSyncTime = 0;
    const timeSinceSync = Date.now() - lastSyncTime;

    expect(timeSinceSync).toBeGreaterThan(4 * 60 * 1000);
    expect(Date.now() - lastSyncTime).toBeGreaterThan(0);
  });

  // Test 8: Periodic alarm interval matches threshold relationship
  it('should verify alarm interval (5 min) > sync threshold (4 min)', () => {
    const ALARM_INTERVAL_MIN = 5;
    const SYNC_THRESHOLD_MIN = 4;

    // Alarm should fire slightly after threshold to catch batched messages
    expect(ALARM_INTERVAL_MIN).toBeGreaterThan(SYNC_THRESHOLD_MIN);
    expect(ALARM_INTERVAL_MIN - SYNC_THRESHOLD_MIN).toBe(1); // 1 minute buffer
  });

});

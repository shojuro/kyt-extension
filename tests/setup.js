/**
 * Jest/Vitest Test Setup for Chrome Extension
 *
 * Sets up mocks for Chrome Extension APIs
 * Follows CLAUDE.md Anti-Theater Rules - Real mocks that can fail
 */

import { vi } from 'vitest';

// Mock Chrome Storage API
const createStorageMock = () => {
  let storage = {};

  return {
    local: {
      get: vi.fn((keys) => {
        return Promise.resolve(
          keys === null
            ? { ...storage }
            : Object.keys(storage)
                .filter(k => keys.includes(k))
                .reduce((obj, key) => ({ ...obj, [key]: storage[key] }), {})
        );
      }),
      set: vi.fn((items) => {
        storage = { ...storage, ...items };
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        storage = {};
        return Promise.resolve();
      }),
      QUOTA_BYTES: 10485760 // 10MB default quota
    },
    // Helper for tests to directly access storage
    _getInternalStorage: () => storage,
    _setInternalStorage: (newStorage) => { storage = newStorage; }
  };
};

// Mock Chrome Runtime API
const createRuntimeMock = () => {
  const listeners = [];

  return {
    onMessage: {
      addListener: vi.fn((callback) => {
        listeners.push(callback);
      }),
      removeListener: vi.fn((callback) => {
        const index = listeners.indexOf(callback);
        if (index > -1) listeners.splice(index, 1);
      }),
      // Helper for tests to simulate message sending
      _triggerMessage: (message, sender = {}) => {
        return new Promise((resolve) => {
          listeners.forEach(listener => {
            listener(message, sender, resolve);
          });
        });
      },
      _getListeners: () => listeners
    },
    sendMessage: vi.fn((message) => {
      // Simulate the behavior: if no listeners, reject
      if (listeners.length === 0) {
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      }
      // Otherwise, resolve (actual response would come from listener)
      return Promise.resolve({ success: true });
    }),
    getManifest: vi.fn(() => ({
      version: '1.0.0',
      name: 'Test Extension'
    }))
  };
};

// Mock Chrome Alarms API
const createAlarmsMock = () => {
  const alarms = {};
  const listeners = [];

  return {
    create: vi.fn((name, alarmInfo) => {
      alarms[name] = alarmInfo;
    }),
    onAlarm: {
      addListener: vi.fn((callback) => {
        listeners.push(callback);
      }),
      // Helper for tests to trigger alarms
      _triggerAlarm: (name) => {
        listeners.forEach(listener => {
          listener({ name });
        });
      }
    }
  };
};

// Setup global chrome object
export const setupChromeMocks = () => {
  const storageMock = createStorageMock();
  const runtimeMock = createRuntimeMock();
  const alarmsMock = createAlarmsMock();

  global.chrome = {
    storage: storageMock,
    runtime: runtimeMock,
    alarms: alarmsMock
  };

  return {
    storage: storageMock,
    runtime: runtimeMock,
    alarms: alarmsMock
  };
};

// Setup fetch mock for API calls
export const setupFetchMock = () => {
  global.fetch = vi.fn();
  return global.fetch;
};

// Reset all mocks between tests
export const resetAllMocks = () => {
  if (global.chrome) {
    global.chrome.storage._setInternalStorage({});
    vi.clearAllMocks();
  }
};

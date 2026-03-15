import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupChromeMocks, resetAllMocks } from '../setup.js';

let mocks;

beforeEach(() => {
  mocks = setupChromeMocks();
  resetAllMocks();
  // Re-setup after resetAllMocks clears mocks
  mocks = setupChromeMocks();
});

// Dynamic import after chrome is set up
const getModule = () => import('../../src/memory-mode.js');

describe('memory-mode constants', () => {
  it('VALID_MODES is exactly [full, clean_room, incognito]', async () => {
    const { VALID_MODES } = await getModule();
    expect(VALID_MODES).toEqual(['full', 'clean_room', 'incognito']);
  });

  it('DEFAULT_MODE is full', async () => {
    const { DEFAULT_MODE } = await getModule();
    expect(DEFAULT_MODE).toBe('full');
  });
});

describe('getMemoryMode()', () => {
  it('returns full (default) when storage is empty', async () => {
    const { getMemoryMode } = await getModule();
    const mode = await getMemoryMode();
    expect(mode).toBe('full');
  });

  it('returns stored value when set', async () => {
    const { getMemoryMode, MEMORY_MODE_KEY } = await getModule();
    await chrome.storage.local.set({ [MEMORY_MODE_KEY]: 'incognito' });
    const mode = await getMemoryMode();
    expect(mode).toBe('incognito');
  });

  it('returns default when stored value is invalid', async () => {
    const { getMemoryMode, MEMORY_MODE_KEY } = await getModule();
    await chrome.storage.local.set({ [MEMORY_MODE_KEY]: 'bogus_mode' });
    const mode = await getMemoryMode();
    expect(mode).toBe('full');
  });
});

describe('setMemoryMode()', () => {
  it('stores incognito to storage', async () => {
    const { setMemoryMode, MEMORY_MODE_KEY } = await getModule();
    await setMemoryMode('incognito');
    const result = await chrome.storage.local.get([MEMORY_MODE_KEY]);
    expect(result[MEMORY_MODE_KEY]).toBe('incognito');
  });

  it('throws error for invalid mode', async () => {
    const { setMemoryMode } = await getModule();
    await expect(setMemoryMode('invalid')).rejects.toThrow('Invalid memory mode: invalid');
  });

  it('round-trip: set then get returns same value', async () => {
    const { setMemoryMode, getMemoryMode } = await getModule();
    await setMemoryMode('clean_room');
    const mode = await getMemoryMode();
    expect(mode).toBe('clean_room');
  });
});

describe('updateBadge()', () => {
  it('sets empty badge text for full mode', async () => {
    const { updateBadge } = await getModule();
    updateBadge('full');
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('sets CR badge with amber color for clean_room', async () => {
    const { updateBadge } = await getModule();
    updateBadge('clean_room');
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'CR' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#D4890B' });
  });

  it('sets OFF badge with gray color for incognito', async () => {
    const { updateBadge } = await getModule();
    updateBadge('incognito');
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: 'OFF' });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: '#888888' });
  });
});

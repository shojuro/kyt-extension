import { getMemoryMode, setMemoryMode as writeMode } from '../lib/config.js';

const VALID_MODES = new Set(['full', 'clean_room', 'incognito']);

export const SET_MEMORY_MODE_SCHEMA = {
  mode: {
    type: 'string',
    description: 'Memory mode: "full" (capture + inject), "clean_room" (capture, no inject), "incognito" (nothing saved)',
  },
};

export async function setMemoryMode({ mode }) {
  if (!mode || !VALID_MODES.has(mode)) {
    return {
      content: [{
        type: 'text',
        text: `Error: mode must be one of: ${[...VALID_MODES].join(', ')}. Got: "${mode}"`,
      }],
      isError: true,
    };
  }

  const previous = getMemoryMode();
  writeMode(mode);

  const descriptions = {
    full: 'Capture conversations + inject context from memory',
    clean_room: 'Capture conversations, but do NOT inject past context',
    incognito: 'Nothing saved, nothing injected',
  };

  return {
    content: [{
      type: 'text',
      text: `Memory mode changed: ${previous} → ${mode}\n${descriptions[mode]}`,
    }],
  };
}

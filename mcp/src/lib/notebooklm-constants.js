/**
 * NotebookLM constants — artifact types, status codes, and enums.
 *
 * Ported from teng-lin/notebooklm-py rpc/types.py.
 */

// --- Artifact type codes ---
export const ARTIFACT_TYPE = {
  AUDIO: 1,
  REPORT: 2,
  VIDEO: 3,
  QUIZ: 4,
  MIND_MAP: 5,
  INFOGRAPHIC: 7,
  SLIDE_DECK: 8,
  DATA_TABLE: 9,
};

export const ARTIFACT_TYPE_LABEL = Object.fromEntries(
  Object.entries(ARTIFACT_TYPE).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')])
);

// --- Artifact status codes ---
export const ARTIFACT_STATUS = {
  PROCESSING: 1,
  PENDING: 2,
  COMPLETED: 3,
  FAILED: 4,
};

export const ARTIFACT_STATUS_LABEL = Object.fromEntries(
  Object.entries(ARTIFACT_STATUS).map(([k, v]) => [v, k.toLowerCase()])
);

// --- Audio enums ---
export const AUDIO_FORMAT = {
  DEEP_DIVE: 1,
  BRIEF: 2,
  CRITIQUE: 3,
  DEBATE: 4,
};

export const AUDIO_LENGTH = {
  SHORT: 1,
  DEFAULT: 2,
  LONG: 3,
};

// --- Video enums ---
export const VIDEO_FORMAT = {
  LECTURE: 1,
  DOCUMENTARY: 2,
  EXPLAINER: 3,
};

export const VIDEO_STYLE = {
  REALISTIC: 1,
  ANIMATED: 2,
  WHITEBOARD: 3,
};

// --- Quiz enums ---
export const QUIZ_VARIANT = {
  FLASHCARDS: 1,
  QUIZ: 2,
};

export const QUIZ_QUANTITY = {
  FEW: 5,
  STANDARD: 10,
  MANY: 15,
};

export const QUIZ_DIFFICULTY = {
  EASY: 1,
  MEDIUM: 2,
  HARD: 3,
};

// --- Infographic enums ---
export const INFOGRAPHIC_ORIENTATION = {
  PORTRAIT: 1,
  LANDSCAPE: 2,
};

export const INFOGRAPHIC_DETAIL = {
  SIMPLE: 1,
  DETAILED: 2,
};

export const INFOGRAPHIC_STYLE = {
  MODERN: 1,
  CLASSIC: 2,
  MINIMAL: 3,
};

// --- Slide Deck enums ---
export const SLIDE_DECK_FORMAT = {
  PRESENTATION: 1,
  SUMMARY: 2,
};

export const SLIDE_DECK_LENGTH = {
  SHORT: 1,
  MEDIUM: 2,
  LONG: 3,
};

// --- Research status codes ---
export const RESEARCH_STATUS = {
  IN_PROGRESS: 1,
  COMPLETED_FAST: 2,
  COMPLETED_DEEP: 6,
};

export const RESEARCH_STATUS_LABEL = {
  1: 'in_progress',
  2: 'completed',
  6: 'completed',
};

// --- Source type codes ---
export const SOURCE_TYPE = {
  WEB: 1,
  DRIVE: 2,
};

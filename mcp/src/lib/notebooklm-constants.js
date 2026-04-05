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
  EXPLAINER: 1,
  BRIEF: 2,
  CINEMATIC: 3,
};

export const VIDEO_STYLE = {
  AUTO_SELECT: 1,
  CUSTOM: 2,
  CLASSIC: 3,
  WHITEBOARD: 4,
  KAWAII: 5,
  ANIME: 6,
  WATERCOLOR: 7,
  RETRO_PRINT: 8,
  HERITAGE: 9,
  PAPER_CRAFT: 10,
};

// --- Quiz enums ---
export const QUIZ_VARIANT = {
  FLASHCARDS: 1,
  QUIZ: 2,
};

export const QUIZ_QUANTITY = {
  FEWER: 1,
  STANDARD: 2,
};

export const QUIZ_DIFFICULTY = {
  EASY: 1,
  MEDIUM: 2,
  HARD: 3,
};

// --- Infographic enums ---
export const INFOGRAPHIC_ORIENTATION = {
  LANDSCAPE: 1,
  PORTRAIT: 2,
  SQUARE: 3,
};

export const INFOGRAPHIC_DETAIL = {
  CONCISE: 1,
  STANDARD: 2,
  DETAILED: 3,
};

export const INFOGRAPHIC_STYLE = {
  AUTO_SELECT: 1,
  SKETCH_NOTE: 2,
  PROFESSIONAL: 3,
  BENTO_GRID: 4,
  EDITORIAL: 5,
  INSTRUCTIONAL: 6,
  BRICKS: 7,
  CLAY: 8,
  ANIME: 9,
  KAWAII: 10,
  SCIENTIFIC: 11,
};

// --- Slide Deck enums ---
export const SLIDE_DECK_FORMAT = {
  DETAILED_DECK: 1,
  PRESENTER_SLIDES: 2,
};

export const SLIDE_DECK_LENGTH = {
  DEFAULT: 1,
  SHORT: 2,
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

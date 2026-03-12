/**
 * Session Manager — Per-session state for voice conversations.
 *
 * Tracks: memory cache, conversation buffer, session metadata.
 * One SessionState per WebSocket connection.
 */

import type { MemoryItem } from './memory-bridge.ts';

export interface SessionState {
  sessionId: string;
  userId: string;
  createdAt: number;
  lastActivityAt: number;
  /** Cached memory items from last search */
  memoryCache: MemoryItem[];
  /** Running conversation buffer for context */
  conversationBuffer: ConversationTurn[];
  /** Whether initial memory fetch has completed */
  initialMemoryLoaded: boolean;
  /** OpenAI WebSocket connection */
  openaiWs: import('ws').WebSocket | null;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  transcript: string;
  timestamp: number;
}

const sessions = new Map<string, SessionState>();

/** Auto-disconnect after 60s silence */
const SILENCE_TIMEOUT_MS = 60_000;
/** Max session duration: 30 minutes */
const MAX_SESSION_MS = 30 * 60 * 1000;

export function createSession(sessionId: string, userId: string): SessionState {
  const state: SessionState = {
    sessionId,
    userId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    memoryCache: [],
    conversationBuffer: [],
    initialMemoryLoaded: false,
    openaiWs: null,
  };
  sessions.set(sessionId, state);
  return state;
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session?.openaiWs) {
    try {
      session.openaiWs.close();
    } catch {
      // Already closed
    }
  }
  sessions.delete(sessionId);
}

export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivityAt = Date.now();
  }
}

export function addTurn(sessionId: string, role: 'user' | 'assistant', transcript: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.conversationBuffer.push({ role, transcript, timestamp: Date.now() });
  // Keep last 20 turns for context
  if (session.conversationBuffer.length > 20) {
    session.conversationBuffer = session.conversationBuffer.slice(-20);
  }
}

export function updateMemoryCache(sessionId: string, items: MemoryItem[]): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.memoryCache = items;
    session.initialMemoryLoaded = true;
  }
}

/**
 * Get recent conversation context as a query string for memory search.
 */
export function getRecentContext(sessionId: string): string {
  const session = sessions.get(sessionId);
  if (!session || session.conversationBuffer.length === 0) {
    return 'recent topics and interests';
  }
  // Use last 3 user messages as context
  return session.conversationBuffer
    .filter((t) => t.role === 'user')
    .slice(-3)
    .map((t) => t.transcript)
    .join(' ');
}

/**
 * Check if a session has exceeded silence or max duration limits.
 */
export function isSessionExpired(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return true;
  const now = Date.now();
  if (now - session.lastActivityAt > SILENCE_TIMEOUT_MS) return true;
  if (now - session.createdAt > MAX_SESSION_MS) return true;
  return false;
}

/**
 * Clean up expired sessions. Call periodically.
 */
export function cleanupExpiredSessions(): number {
  let cleaned = 0;
  for (const [id] of sessions) {
    if (isSessionExpired(id)) {
      destroySession(id);
      cleaned++;
    }
  }
  return cleaned;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

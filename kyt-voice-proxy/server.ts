/**
 * K.Y.T. Voice Proxy Server
 *
 * WebSocket server that bridges Android voice app ↔ OpenAI Realtime API,
 * injecting K.Y.T. memory context into the AI's system prompt.
 *
 * Architecture:
 *   Android App ── WebSocket ──→ This Proxy ── WebSocket ──→ OpenAI Realtime API
 *
 * Auth: Android sends Supabase JWT on connect. Proxy validates and extracts user_id.
 *
 * Memory injection:
 *   1. On session start: search_memories with recent context → session.update system prompt
 *   2. After each user turn (transcript available): IntentClassifier → refresh if QUERY
 *   3. On response.done: save both turns via save_chat_turn_batch
 */

import 'dotenv/config';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

import {
  searchMemories,
  buildVoiceSystemPrompt,
  callEdgeFunction,
} from './memory-bridge.ts';
import { saveVoiceTurns } from './save-bridge.ts';
import {
  createSession,
  getSession,
  destroySession,
  touchSession,
  addTurn,
  updateMemoryCache,
  getRecentContext,
  cleanupExpiredSessions,
  getActiveSessionCount,
} from './session-manager.ts';
import { classifyIntent } from './intent-classifier.ts';

const PORT = parseInt(process.env.PORT || '8080', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';

if (!OPENAI_API_KEY) {
  console.error('FATAL: OPENAI_API_KEY not set');
  process.exit(1);
}

// ── JWT Validation ───────────────────────────────────────────

interface JwtPayload {
  sub: string; // user_id
  exp: number;
  role?: string;
}

/**
 * Decode JWT without verification (proxy trusts Supabase-issued tokens).
 * In production, add JWKS verification.
 */
function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null; // Expired
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

// ── OpenAI Realtime API Connection ───────────────────────────

function connectToOpenAI(sessionId: string): WebSocket {
  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
  return ws;
}

// ── Session Lifecycle ────────────────────────────────────────

async function handleClientConnection(clientWs: WebSocket, userId: string): Promise<void> {
  const sessionId = randomUUID();
  const session = createSession(sessionId, userId);

  console.log(`[session:${sessionId.slice(0, 8)}] New voice session for user ${userId.slice(0, 8)}`);

  // Connect to OpenAI Realtime API
  const openaiWs = connectToOpenAI(sessionId);
  session.openaiWs = openaiWs;

  // Track pending user/assistant transcripts for save
  let pendingUserTranscript = '';
  let pendingAssistantTranscript = '';

  // ── OpenAI WebSocket handlers ──────────────────────────────

  openaiWs.on('open', async () => {
    console.log(`[session:${sessionId.slice(0, 8)}] Connected to OpenAI Realtime API`);

    // Fetch initial memory context
    try {
      const context = getRecentContext(sessionId);
      const result = await searchMemories(context, userId, true);
      updateMemoryCache(sessionId, result.items);

      // Send session.update with memory-enriched system prompt
      const systemPrompt = buildVoiceSystemPrompt(result.items);
      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: systemPrompt,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad' },
          },
        }),
      );
      console.log(`[session:${sessionId.slice(0, 8)}] Initial memory loaded: ${result.items.length} items`);
    } catch (err) {
      console.error(`[session:${sessionId.slice(0, 8)}] Initial memory fetch failed:`, err);
      // Continue without memory — still functional
      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: buildVoiceSystemPrompt([]),
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad' },
          },
        }),
      );
    }
  });

  openaiWs.on('message', async (data) => {
    touchSession(sessionId);
    const msg = JSON.parse(data.toString());

    switch (msg.type) {
      // ── User transcript available (from server VAD) ──────
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = msg.transcript || '';
        if (transcript) {
          pendingUserTranscript = transcript;
          addTurn(sessionId, 'user', transcript);

          // Run intent classifier — refresh memory if QUERY
          const classification = classifyIntent(transcript);
          if (classification.intent === 'QUERY') {
            try {
              const result = await searchMemories(transcript, userId, true);
              updateMemoryCache(sessionId, result.items);

              // Update system prompt with fresh context
              const systemPrompt = buildVoiceSystemPrompt(result.items);
              openaiWs.send(
                JSON.stringify({
                  type: 'session.update',
                  session: { instructions: systemPrompt },
                }),
              );
              console.log(
                `[session:${sessionId.slice(0, 8)}] Memory refreshed (${classification.reason}): ${result.items.length} items`,
              );
            } catch (err) {
              console.error(`[session:${sessionId.slice(0, 8)}] Memory refresh failed:`, err);
            }
          }
        }
        break;
      }

      // ── AI response complete ─────────────────────────────
      case 'response.done': {
        // Extract assistant transcript from response
        const output = msg.response?.output;
        if (Array.isArray(output)) {
          for (const item of output) {
            if (item.type === 'message' && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part.type === 'audio' && part.transcript) {
                  pendingAssistantTranscript = part.transcript;
                  addTurn(sessionId, 'assistant', part.transcript);
                }
              }
            }
          }
        }

        // Save both turns (fire-and-forget)
        if (pendingUserTranscript || pendingAssistantTranscript) {
          saveVoiceTurns(userId, sessionId, pendingUserTranscript, pendingAssistantTranscript);
          pendingUserTranscript = '';
          pendingAssistantTranscript = '';
        }
        break;
      }

      case 'error': {
        console.error(`[session:${sessionId.slice(0, 8)}] OpenAI error:`, msg.error);
        break;
      }
    }

    // Forward all OpenAI messages to client (audio, transcription, etc.)
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });

  openaiWs.on('close', (code, reason) => {
    console.log(`[session:${sessionId.slice(0, 8)}] OpenAI WS closed: ${code}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1000, 'OpenAI connection closed');
    }
    destroySession(sessionId);
  });

  openaiWs.on('error', (err) => {
    console.error(`[session:${sessionId.slice(0, 8)}] OpenAI WS error:`, err);
  });

  // ── Client WebSocket handlers ──────────────────────────────

  clientWs.on('message', (data) => {
    touchSession(sessionId);
    // Forward client messages (audio frames, etc.) to OpenAI
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(data);
    }
  });

  clientWs.on('close', () => {
    console.log(`[session:${sessionId.slice(0, 8)}] Client disconnected`);
    destroySession(sessionId);
  });

  clientWs.on('error', (err) => {
    console.error(`[session:${sessionId.slice(0, 8)}] Client WS error:`, err);
  });
}

// ── HTTP + WebSocket Server ──────────────────────────────────

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        activeSessions: getActiveSessionCount(),
        uptime: process.uptime(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Extract JWT from query string: ws://host:port?token=<jwt>
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Missing auth token');
    return;
  }

  const payload = decodeJwt(token);
  if (!payload?.sub) {
    ws.close(4001, 'Invalid or expired token');
    return;
  }

  handleClientConnection(ws, payload.sub);
});

// ── Periodic Cleanup ─────────────────────────────────────────

setInterval(() => {
  const cleaned = cleanupExpiredSessions();
  if (cleaned > 0) {
    console.log(`[cleanup] Removed ${cleaned} expired sessions`);
  }
}, 30_000);

// ── Start ────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`K.Y.T. Voice Proxy listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

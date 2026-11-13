/**
 * K.Y.T. Claude send-request reader/editor (page context, world: MAIN).
 *
 * Since late 2026 claude.ai sends a chat message as a binary protobuf body:
 *   POST /claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction
 *   content-type: application/proto
 * replacing the old JSON `/chat_conversations/{id}/completion` request.
 *
 * Observed layout of a "send message" action (2026-11-13 recording):
 *   1    request context        1.2 = conversation id (string)
 *   2    send-message action    2.3 = prompt (string), 2.7.2 = model (string)
 * Other actions use other top-level fields (for example 15) and carry no prompt.
 *
 * There is no published schema, so this works on the protobuf wire format
 * only: it finds field 2 -> field 3, and when asked to replace the prompt it
 * rewrites just those two length prefixes and copies every other byte as is.
 * Anything unexpected returns null, and the caller sends the original body.
 *
 * Loaded as a classic script before content_test.js; exposes KYT_ClaudeProto.
 */
(function (root) {
  'use strict';

  const SEND_PATH = 'ConversationService/PerformAction';
  const WIRE_VARINT = 0;
  const WIRE_I64 = 1;
  const WIRE_LEN = 2;
  const WIRE_I32 = 5;
  const FIELD_CONTEXT = 1;
  const FIELD_SEND = 2;
  const FIELD_CONTEXT_CONVERSATION = 2;
  const FIELD_SEND_PROMPT = 3;
  const FIELD_SEND_MODEL_BOX = 7;
  const FIELD_MODEL_NAME = 2;

  /** Read a varint as a Number. Returns null when truncated or above 2^35. */
  function readVarint(bytes, offset) {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      const pos = offset + i;
      if (pos >= bytes.length) return null;
      const byte = bytes[pos];
      if (i < 5) {
        value += (byte & 0x7f) * scale;
        scale *= 128;
      } else if (byte & 0x7f) {
        // Lengths and field keys never get this large; 64-bit values are only skipped.
        value = Number.MAX_SAFE_INTEGER;
      }
      if (!(byte & 0x80)) return { value, next: pos + 1 };
    }
    return null;
  }

  function writeVarint(value) {
    const out = [];
    let v = value;
    while (v > 0x7f) {
      out.push((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  }

  /**
   * Split a message into its top-level fields.
   * Returns [{ field, wire, start, dataStart, end }] or null if malformed.
   */
  function splitFields(bytes) {
    const fields = [];
    let offset = 0;
    while (offset < bytes.length) {
      const key = readVarint(bytes, offset);
      if (!key) return null;
      const field = Math.floor(key.value / 8);
      const wire = key.value % 8;
      if (field < 1) return null;
      let dataStart = key.next;
      let end;
      if (wire === WIRE_VARINT) {
        const v = readVarint(bytes, dataStart);
        if (!v) return null;
        end = v.next;
      } else if (wire === WIRE_LEN) {
        const len = readVarint(bytes, dataStart);
        if (!len) return null;
        dataStart = len.next;
        end = dataStart + len.value;
      } else if (wire === WIRE_I64) {
        end = dataStart + 8;
      } else if (wire === WIRE_I32) {
        end = dataStart + 4;
      } else {
        return null; // groups and unknown wire types: do not touch
      }
      if (end > bytes.length) return null;
      fields.push({ field, wire, start: offset, dataStart, end });
      offset = end;
    }
    return fields;
  }

  function only(fields, fieldNumber) {
    const matches = fields.filter((f) => f.field === fieldNumber);
    if (matches.length !== 1 || matches[0].wire !== WIRE_LEN) return null;
    return matches[0];
  }

  function decodeUtf8(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function readString(bytes, fields, fieldNumber) {
    const f = only(fields, fieldNumber);
    return f ? decodeUtf8(bytes.subarray(f.dataStart, f.end)) : null;
  }

  /** Normalise a fetch body to a Uint8Array view, or null for other body types. */
  function toBytes(body) {
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return null;
  }

  function isSendUrl(url) {
    return typeof url === 'string' && url.includes(SEND_PATH);
  }

  function locate(bytes) {
    const top = splitFields(bytes);
    if (!top) return null;
    const send = only(top, FIELD_SEND);
    if (!send) return null;
    const sendBytes = bytes.subarray(send.dataStart, send.end);
    const inner = splitFields(sendBytes);
    if (!inner) return null;
    const prompt = only(inner, FIELD_SEND_PROMPT);
    if (!prompt) return null;
    const text = decodeUtf8(sendBytes.subarray(prompt.dataStart, prompt.end));
    if (text === null || text.length === 0) return null;
    return { top, send, sendBytes, inner, prompt, text };
  }

  /**
   * Read the user's prompt from a send-message body.
   * @returns {{prompt: string, conversationId: string|null, model: string|null}|null}
   */
  function readSend(body) {
    const bytes = toBytes(body);
    if (!bytes) return null;
    const found = locate(bytes);
    if (!found) return null;

    let conversationId = null;
    const context = only(found.top, FIELD_CONTEXT);
    if (context) {
      const ctxBytes = bytes.subarray(context.dataStart, context.end);
      const ctxFields = splitFields(ctxBytes);
      if (ctxFields) conversationId = readString(ctxBytes, ctxFields, FIELD_CONTEXT_CONVERSATION);
    }

    let model = null;
    const modelBox = only(found.inner, FIELD_SEND_MODEL_BOX);
    if (modelBox) {
      const boxBytes = found.sendBytes.subarray(modelBox.dataStart, modelBox.end);
      const boxFields = splitFields(boxBytes);
      if (boxFields) model = readString(boxBytes, boxFields, FIELD_MODEL_NAME);
    }

    return { prompt: found.text, conversationId, model };
  }

  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /**
   * Return a copy of the body with the prompt replaced.
   * Only the prompt bytes and the two enclosing length prefixes change.
   * @returns {Uint8Array|null} null when the body is not a recognised send action
   */
  function replacePrompt(body, newPrompt) {
    const bytes = toBytes(body);
    if (!bytes || typeof newPrompt !== 'string' || newPrompt.length === 0) return null;
    const found = locate(bytes);
    if (!found) return null;

    const promptBytes = new TextEncoder().encode(newPrompt);
    const { sendBytes, prompt, send } = found;
    const promptKey = sendBytes.subarray(prompt.start, readVarint(sendBytes, prompt.start).next);
    const newSend = concat([
      sendBytes.subarray(0, prompt.start),
      promptKey,
      Uint8Array.from(writeVarint(promptBytes.length)),
      promptBytes,
      sendBytes.subarray(prompt.end),
    ]);

    const sendKey = bytes.subarray(send.start, readVarint(bytes, send.start).next);
    const rebuilt = concat([
      bytes.subarray(0, send.start),
      sendKey,
      Uint8Array.from(writeVarint(newSend.length)),
      newSend,
      bytes.subarray(send.end),
    ]);

    // Self-check: the rebuilt body must read back as the new prompt.
    const check = locate(rebuilt);
    if (!check || check.text !== newPrompt) return null;
    return rebuilt;
  }

  root.KYT_ClaudeProto = { SEND_PATH, isSendUrl, readSend, replacePrompt };
})(typeof window !== 'undefined' ? window : globalThis);

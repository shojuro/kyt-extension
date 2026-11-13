/**
 * K.Y.T. Gemini send-request reader/editor (page context, world: MAIN).
 *
 * Since late 2026 gemini.google.com sends a chat message over a session
 * channel instead of the old StreamGenerate form:
 *   POST https://geminiweb-pa.clients6.google.com/v1/processSession
 *   content-type: application/x-www-form-urlencoded
 *   count=2&ofs=0&req0___data__=<base64>&req1___data__=<base64>
 * Each reqN___data__ value is a base64 protobuf message. The one that carries
 * the user's prompt looks like this (2026-11-13 recording):
 *   2 { 1: 1, 9 { 1: "<prompt>" } }
 * Other messages on the channel (session setup, acknowledgements) have no
 * field 2.9.1 and are left alone.
 *
 * There is no published schema, so this works on the protobuf wire format
 * only. Replacing the prompt rewrites the prompt bytes and the length
 * prefixes that enclose them; every other byte, and every other form
 * parameter, is copied as is. Anything unexpected returns null and the caller
 * sends the original body.
 *
 * Loaded as a classic script next to inject.js; exposes KYT_GeminiSession.
 */
(function (root) {
  'use strict';

  const SESSION_HOST = 'geminiweb-pa.clients6.google.com';
  const SESSION_PATH = '/v1/processSession';
  const PROMPT_PATH = [2, 9, 1];
  const DATA_PARAM_RE = /(^|&)(req\d+___data__)=([^&]*)/g;
  const WIRE_VARINT = 0;
  const WIRE_I64 = 1;
  const WIRE_LEN = 2;
  const WIRE_I32 = 5;

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
        value = Number.MAX_SAFE_INTEGER; // 64-bit values are only skipped, never used
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

  /** Split a message into fields: [{ field, wire, start, dataStart, end }] or null. */
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
        return null;
      }
      if (end > bytes.length) return null;
      fields.push({ field, wire, start: offset, dataStart, end });
      offset = end;
    }
    return fields;
  }

  function only(bytes, fieldNumber) {
    const fields = splitFields(bytes);
    if (!fields) return null;
    const matches = fields.filter((f) => f.field === fieldNumber);
    if (matches.length !== 1 || matches[0].wire !== WIRE_LEN) return null;
    return matches[0];
  }

  /** Bytes at a nested field path, or null. */
  function readPath(bytes, path) {
    let current = bytes;
    for (const fieldNumber of path) {
      const f = only(current, fieldNumber);
      if (!f) return null;
      current = current.subarray(f.dataStart, f.end);
    }
    return current;
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

  /** Copy of `bytes` with the payload at `path` replaced, lengths fixed up. */
  function replacePath(bytes, path, payload) {
    const f = only(bytes, path[0]);
    if (!f) return null;
    const inner = path.length === 1
      ? payload
      : replacePath(bytes.subarray(f.dataStart, f.end), path.slice(1), payload);
    if (!inner) return null;
    const key = bytes.subarray(f.start, readVarint(bytes, f.start).next);
    return concat([
      bytes.subarray(0, f.start),
      key,
      Uint8Array.from(writeVarint(inner.length)),
      inner,
      bytes.subarray(f.end),
    ]);
  }

  function decodeUtf8(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      return null;
    }
  }

  function fromBase64(text) {
    try {
      const standard = text.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(standard);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  /** Encode in the same alphabet and padding style as `like`. */
  function toBase64(bytes, like) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    let text = btoa(binary);
    if (/[-_]/.test(like)) text = text.replace(/\+/g, '-').replace(/\//g, '_');
    if (like.length % 4 !== 0 && !like.endsWith('=')) text = text.replace(/=+$/, '');
    return text;
  }

  function isSessionUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      const parsed = new URL(url, 'https://gemini.google.com');
      return parsed.hostname === SESSION_HOST && parsed.pathname === SESSION_PATH;
    } catch (_) {
      return false;
    }
  }

  /** Find the one form parameter that carries a prompt. */
  function locate(bodyStr) {
    if (typeof bodyStr !== 'string' || bodyStr.length === 0) return null;
    const hits = [];
    DATA_PARAM_RE.lastIndex = 0;
    let m;
    while ((m = DATA_PARAM_RE.exec(bodyStr)) !== null) {
      let raw;
      try {
        raw = decodeURIComponent(m[3].replace(/\+/g, '%20'));
      } catch (_) {
        continue;
      }
      const bytes = fromBase64(raw);
      if (!bytes || bytes.length === 0) continue;
      const promptBytes = readPath(bytes, PROMPT_PATH);
      if (!promptBytes) continue;
      const prompt = decodeUtf8(promptBytes);
      if (prompt === null || prompt.length === 0) continue;
      hits.push({
        name: m[2],
        valueStart: m.index + m[1].length + m[2].length + 1,
        valueEnd: m.index + m[0].length,
        raw,
        bytes,
        prompt,
      });
    }
    return hits.length === 1 ? hits[0] : null; // zero or several: do not guess
  }

  /**
   * Read the user's prompt from a processSession form body.
   * @returns {{prompt: string, param: string}|null}
   */
  function readSend(bodyStr) {
    const hit = locate(bodyStr);
    return hit ? { prompt: hit.prompt, param: hit.name } : null;
  }

  /**
   * Return the form body with the prompt replaced, or null.
   * Only the one reqN___data__ value changes.
   */
  function replacePrompt(bodyStr, newPrompt) {
    if (typeof newPrompt !== 'string' || newPrompt.length === 0) return null;
    const hit = locate(bodyStr);
    if (!hit) return null;
    const rebuilt = replacePath(hit.bytes, PROMPT_PATH, new TextEncoder().encode(newPrompt));
    if (!rebuilt) return null;
    const out = bodyStr.slice(0, hit.valueStart) +
      encodeURIComponent(toBase64(rebuilt, hit.raw)) +
      bodyStr.slice(hit.valueEnd);
    // Self-check: the rebuilt body must read back as the new prompt.
    const check = locate(out);
    if (!check || check.prompt !== newPrompt || check.name !== hit.name) return null;
    return out;
  }

  root.KYT_GeminiSession = { isSessionUrl, readSend, replacePrompt };
})(typeof window !== 'undefined' ? window : globalThis);

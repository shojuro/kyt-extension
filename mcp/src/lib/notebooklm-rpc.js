/**
 * NotebookLM batchexecute wire format encoder/decoder.
 *
 * Ported from teng-lin/notebooklm-py (Python reverse-engineered CLI).
 * Google's batchexecute format: triple-nested arrays, URL-encoded form body,
 * chunked response with anti-XSSI prefix.
 */

// --- RPC Method IDs ---
export const RPC = {
  LIST_NOTEBOOKS: 'wXbhsf',
  CREATE_NOTEBOOK: 'CCqFvf',
  GET_NOTEBOOK: 'rLM1Ne',
  DELETE_NOTEBOOK: 'WWINqb',
  ADD_SOURCE: 'izAoDd',
  DELETE_SOURCE: 'tGMBJ',
  GET_CONVERSATION_ID: 'hPTbtc',
  GET_CONVERSATION_TURNS: 'khqZz',
};

// --- Endpoints ---
export const BATCHEXECUTE_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute';
export const STREAMING_URL = 'https://notebooklm.google.com/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed';

/**
 * Encode an RPC request into the batchexecute wire format.
 *
 * @param {string} methodId - RPC method ID (e.g. 'wXbhsf')
 * @param {any[]} params - Parameter array (positional, nulls for missing)
 * @returns {string} JSON-encoded outer array
 */
export function encodeRpcRequest(methodId, params) {
  const paramsJson = JSON.stringify(params);
  return JSON.stringify([[[methodId, paramsJson, null, 'generic']]]);
}

/**
 * Build the full URL-encoded form body for a batchexecute request.
 *
 * @param {string} encodedRpc - Output of encodeRpcRequest()
 * @param {string} csrfToken - SNlM0e CSRF token
 * @returns {string} URL-encoded form body
 */
export function buildRequestBody(encodedRpc, csrfToken) {
  return `f.req=${encodeURIComponent(encodedRpc)}&at=${encodeURIComponent(csrfToken)}&`;
}

/**
 * Build the query string for a batchexecute request.
 *
 * @param {string} methodId - RPC method ID
 * @param {string} sessionId - FdrFJe session ID
 * @param {string} [sourcePath] - Optional source-path (e.g. '/notebook/{id}')
 * @returns {string} Query string (without leading ?)
 */
export function buildQueryString(methodId, sessionId, sourcePath) {
  const params = new URLSearchParams({
    'rpcids': methodId,
    'f.sid': sessionId,
    'hl': 'en',
    'rt': 'c',
  });
  if (sourcePath) {
    params.set('source-path', sourcePath);
  }
  return params.toString();
}

/**
 * Decode a batchexecute chunked response.
 *
 * Format: `)]}'\n` prefix, then alternating `<byte_count>\n<JSON>\n` lines.
 * Each chunk may contain `["wrb.fr", methodId, resultData, ...]`.
 *
 * @param {string} responseText - Raw response body
 * @param {string} methodId - Expected RPC method ID
 * @returns {any} Parsed result data (may need second JSON.parse)
 */
export function decodeResponse(responseText, methodId) {
  // Strip anti-XSSI prefix
  let text = responseText;
  if (text.startsWith(")]}'")) {
    text = text.slice(text.indexOf('\n') + 1);
  }

  // Parse chunked format: alternating byte-count and JSON lines
  const chunks = parseChunkedResponse(text);

  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;

    // Look for wrb.fr frames
    for (const item of chunk) {
      if (!Array.isArray(item)) continue;
      if (item[0] === 'wrb.fr' && item[1] === methodId) {
        const resultData = item[2];
        if (resultData === null) {
          // Check for UserDisplayableError (rate limit)
          if (item[5] && String(item[5]).includes('UserDisplayableError')) {
            throw new Error('NotebookLM rate limit exceeded');
          }
          return null;
        }
        // Result is often a JSON string needing second parse
        if (typeof resultData === 'string') {
          try {
            return JSON.parse(resultData);
          } catch {
            return resultData;
          }
        }
        return resultData;
      }
    }
  }

  throw new Error(`No wrb.fr frame found for method ${methodId}`);
}

/**
 * Parse the chunked response format (byte-count + JSON alternating lines).
 *
 * @param {string} text - Response text after anti-XSSI prefix removal
 * @returns {any[]} Array of parsed JSON chunks
 */
function parseChunkedResponse(text) {
  const chunks = [];

  // Simple line-based approach: split on \n, find numeric lines (byte counts),
  // then collect the JSON between them. Works because Google's format is:
  //   )]}'          <- anti-XSSI (already stripped)
  //   \n
  //   19213\n       <- byte count
  //   [[...JSON...] <- content
  //   \n
  //   25\n          <- next chunk byte count
  //   [[...]]       <- next chunk
  //
  // Instead of byte-counting (which is error-prone with UTF-8), we find
  // balanced JSON by locating array starts/ends after each byte-count line.

  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // Is this a byte-count line? (pure digits)
    if (/^\d+$/.test(line)) {
      // Collect subsequent non-empty, non-digit lines as the JSON chunk
      i++;
      let jsonLines = [];
      while (i < lines.length) {
        const next = lines[i].trim();
        // Stop at the next byte-count line or empty line followed by digits
        if (/^\d+$/.test(next) && jsonLines.length > 0) break;
        if (next) jsonLines.push(lines[i]); // preserve original whitespace
        i++;
      }
      if (jsonLines.length > 0) {
        const jsonText = jsonLines.join('\n').trim();
        try {
          chunks.push(JSON.parse(jsonText));
        } catch {
          // Skip unparseable chunks
        }
      }
    } else {
      i++;
    }
  }

  return chunks;
}

/**
 * Decode a streaming response (used for ask/query).
 *
 * Same anti-XSSI prefix, chunked format. Answer text is in wrb.fr frames.
 *
 * @param {string} responseText - Raw streaming response
 * @returns {{ answer: string, citations: any[], conversationId: string|null }}
 */
export function decodeStreamingResponse(responseText) {
  let text = responseText;
  if (text.startsWith(")]}'")) {
    text = text.slice(text.indexOf('\n') + 1);
  }

  const chunks = parseChunkedResponse(text);
  let answer = '';
  let citations = [];
  let conversationId = null;

  for (const chunk of chunks) {
    if (!Array.isArray(chunk)) continue;

    for (const item of chunk) {
      if (!Array.isArray(item)) continue;
      if (item[0] !== 'wrb.fr') continue;

      const resultData = item[2];
      if (!resultData) continue;

      let parsed = resultData;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { continue; }
      }

      // Extract answer text — typically at parsed[0] or parsed[4]
      if (Array.isArray(parsed)) {
        // Answer text is usually in the last meaningful frame
        const candidateText = extractAnswerText(parsed);
        if (candidateText) answer = candidateText;

        // Citations
        const candidateCitations = extractCitations(parsed);
        if (candidateCitations.length > 0) citations = candidateCitations;

        // Conversation ID
        const candidateConvId = extractConversationId(parsed);
        if (candidateConvId) conversationId = candidateConvId;
      }
    }
  }

  return { answer: answer.trim(), citations, conversationId };
}

/**
 * Extract answer text from a parsed streaming frame.
 * The answer typically lives deep in the nested arrays.
 */
function extractAnswerText(parsed) {
  // Common positions for answer text in streaming frames
  // Position [4] often contains the full answer in later frames
  if (parsed[4] && typeof parsed[4] === 'string' && parsed[4].length > 10) {
    return parsed[4];
  }
  // Position [0] may contain partial text
  if (parsed[0] && typeof parsed[0] === 'string' && parsed[0].length > 10) {
    return parsed[0];
  }
  // Walk the structure looking for the longest string
  let longest = '';
  function walk(obj, depth) {
    if (depth > 8) return;
    if (typeof obj === 'string' && obj.length > longest.length && obj.length > 20) {
      longest = obj;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
    }
  }
  walk(parsed, 0);
  return longest || null;
}

/**
 * Extract citations from a parsed streaming frame.
 * Citations are arrays with source_id, cited_text, start/end positions.
 */
function extractCitations(parsed) {
  const citations = [];
  function walk(obj, depth) {
    if (depth > 10 || !Array.isArray(obj)) return;
    // Citation arrays typically have: [source_id, null, cited_text, start_char, end_char]
    // or [null, source_id, cited_text, ...]
    if (obj.length >= 3 && typeof obj[0] === 'string' && typeof obj[2] === 'string'
        && obj[0].length > 5 && obj[2].length > 5) {
      citations.push({
        source_id: obj[0],
        cited_text: obj[2],
        start_char: typeof obj[3] === 'number' ? obj[3] : null,
        end_char: typeof obj[4] === 'number' ? obj[4] : null,
      });
      return;
    }
    for (const item of obj) walk(item, depth + 1);
  }
  walk(parsed, 0);
  return citations;
}

/**
 * Extract conversation ID from a parsed frame (UUID format).
 */
function extractConversationId(parsed) {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function walk(obj, depth) {
    if (depth > 8) return null;
    if (typeof obj === 'string' && uuidRe.test(obj)) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(parsed, 0);
}

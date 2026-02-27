import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env from mcp/ directory (not cwd, which may be project root)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { queryMemory } from './tools/query-memory.js';
import { searchEntities } from './tools/search-entities.js';
import { saveNote } from './tools/save-note.js';
import { getPreferences } from './tools/get-preferences.js';
import { setMemoryMode } from './tools/set-memory-mode.js';
import { ingestSession } from './tools/ingest-session.js';

const server = new McpServer({
  name: 'kyt-memory',
  version: '1.0.0',
});

// --- Tool: query_memory ---
server.tool(
  'query_memory',
  'Search cross-platform conversation memory (ChatGPT, Claude web, Claude Code). Returns ranked results with content, confidence scores, platform, date, and extracted entities.',
  {
    query: z.string().describe('Search query for cross-platform memory'),
    topK: z.number().optional().default(5).describe('Number of results (default: 5)'),
    useHyde: z.boolean().optional().default(true).describe('Enable HyDE augmented search'),
    platform: z.enum(['all', 'chatgpt', 'claude', 'claude-code', 'cli']).optional().default('all')
      .describe('Filter by platform'),
  },
  async (args) => queryMemory(args),
);

// --- Tool: search_entities ---
server.tool(
  'search_entities',
  'Search the entity knowledge graph for people, projects, technologies, and concepts extracted from all conversations.',
  {
    query: z.string().describe('Entity name or text to search for'),
    limit: z.number().optional().default(5).describe('Max results (default: 5)'),
  },
  async (args) => searchEntities(args),
);

// --- Tool: save_note ---
server.tool(
  'save_note',
  'Save an explicit note or decision to K.Y.T. memory. Useful for recording architecture decisions, preferences, or facts you want to remember across sessions.',
  {
    content: z.string().describe('Note content to save'),
    tags: z.array(z.string()).optional().default([]).describe('Optional tags'),
  },
  async (args) => saveNote(args),
);

// --- Tool: get_preferences ---
server.tool(
  'get_preferences',
  'Look up user preferences by category (e.g. "car", "language", "editor"). Returns preferences extracted from past conversations.',
  {
    category: z.string().describe('Preference category to look up'),
  },
  async (args) => getPreferences(args),
);

// --- Tool: set_memory_mode ---
server.tool(
  'set_memory_mode',
  'Change K.Y.T. memory mode. "full" = capture + inject, "clean_room" = capture only, "incognito" = nothing saved or injected.',
  {
    mode: z.enum(['full', 'clean_room', 'incognito']).describe('Memory mode'),
  },
  async (args) => setMemoryMode(args),
);

// --- Tool: ingest_session ---
server.tool(
  'ingest_session',
  'Import Claude Code conversation sessions into K.Y.T. memory. Parses JSONL session files, extracts text content, and syncs to Supabase for cross-platform search.',
  {
    sessionId: z.string().optional().describe('Session ID to ingest (defaults to most recent)'),
    all: z.boolean().optional().default(false).describe('Ingest all un-ingested sessions'),
  },
  async (args) => ingestSession(args),
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP JSON-RPC)
process.stderr.write('K.Y.T. MCP server started\n');

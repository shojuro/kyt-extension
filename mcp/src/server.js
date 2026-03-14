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
import { queryCosts } from './tools/query-costs.js';
import { createProject } from './tools/create-project.js';
import { listProjects } from './tools/list-projects.js';
import { setActiveProject } from './tools/set-active-project.js';
import { assignToProject } from './tools/assign-to-project.js';
import { projectDebrief } from './tools/project-debrief.js';

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
    platform: z.enum(['all', 'chatgpt', 'claude', 'claude-code', 'cli', 'gemini']).optional().default('all')
      .describe('Filter by platform'),
    fast: z.boolean().optional().default(false).describe('Fast search (no HyDE/reranking, <1s)'),
    project: z.string().optional().describe('Project UUID to scope search to (default: active project or all)'),
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
    force: z.boolean().optional().default(false).describe('Force re-ingestion (resets ingested count to 0)'),
  },
  async (args) => ingestSession(args),
);

// --- Tool: query_costs ---
server.tool(
  'query_costs',
  'Query K.Y.T. API cost tracking. Shows per-provider, per-operation, per-edge-function, or per-model cost breakdowns with token counts and daily trends.',
  {
    days: z.number().optional().default(7).describe('Number of days to look back (default: 7)'),
    groupBy: z.enum(['provider', 'operation', 'edge_function', 'user', 'model']).optional().default('provider')
      .describe('Group costs by this dimension'),
  },
  async (args) => queryCosts(args),
);

// --- Tool: create_project ---
server.tool(
  'create_project',
  'Create a new K.Y.T. project to organize memories by topic, goal, or context. Vault projects are private and excluded from general search.',
  {
    name: z.string().describe('Project name'),
    description: z.string().optional().describe('Optional project description'),
    isVault: z.boolean().optional().default(false).describe('Make this a vault (private, excluded from general search)'),
    pin: z.string().optional().describe('Required PIN for vault projects (min 4 chars)'),
  },
  async (args) => createProject(args),
);

// --- Tool: list_projects ---
server.tool(
  'list_projects',
  'List all K.Y.T. projects with item counts. Shows name, vault status, item count, and creation date.',
  {
    includeArchived: z.boolean().optional().default(false).describe('Include archived projects'),
  },
  async (args) => listProjects(args),
);

// --- Tool: set_active_project ---
server.tool(
  'set_active_project',
  'Set the active K.Y.T. project. When active, queries and prompt injection are scoped to this project. Pass null projectId to clear.',
  {
    projectId: z.string().nullable().describe('Project UUID to activate (null to clear)'),
    projectName: z.string().optional().describe('Project name for display'),
    pin: z.string().optional().describe('Required PIN to unlock vault projects'),
  },
  async (args) => setActiveProject(args),
);

// --- Tool: assign_to_project ---
server.tool(
  'assign_to_project',
  'Search for memories and assign them to a project. IMPORTANT: You MUST call this with confirm=false first to show the user a preview. Then STOP and ASK the user if they want to proceed. Only call with confirm=true after the user explicitly approves. Never auto-confirm.',
  {
    query: z.string().describe('Search query to find memories'),
    projectId: z.string().describe('Project UUID to assign items to'),
    confirm: z.boolean().optional().default(false).describe('Confirm assignment (false = preview only)'),
  },
  async (args) => assignToProject(args),
);

// --- Tool: project_debrief ---
server.tool(
  'project_debrief',
  'Get a summary/debrief of a K.Y.T. project: item count, platforms, top entities, and recent items.',
  {
    projectId: z.string().describe('Project UUID to debrief'),
    limit: z.number().optional().default(20).describe('Max items in summary (default: 20)'),
  },
  async (args) => projectDebrief(args),
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP JSON-RPC)
process.stderr.write('K.Y.T. MCP server started\n');

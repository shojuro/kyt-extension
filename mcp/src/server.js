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
import { queryTokenStats } from './tools/query-token-stats.js';
import { createProject } from './tools/create-project.js';
import { listProjects } from './tools/list-projects.js';
import { setActiveProject } from './tools/set-active-project.js';
import { assignToProject } from './tools/assign-to-project.js';
import { projectDebrief } from './tools/project-debrief.js';
import { setVaultPin } from './tools/set-vault-pin.js';
import { listNotebooksHandler } from './tools/list-notebooks.js';
import { createNotebookHandler } from './tools/create-notebook.js';
import { pushProjectToNotebookHandler } from './tools/push-project-to-notebook.js';
import { askNotebookHandler } from './tools/ask-notebook.js';
// Sources
import { addSourceHandler } from './tools/add-source.js';
import { listSourcesHandler } from './tools/list-sources.js';
import { deleteSourceHandler } from './tools/delete-source.js';
import { getSourceHandler } from './tools/get-source.js';
// Notebook management
import { renameNotebookHandler } from './tools/rename-notebook.js';
import { deleteNotebookHandler } from './tools/delete-notebook.js';
import { getConversationHistoryHandler } from './tools/get-conversation-history.js';
import { getNotebookSummaryHandler } from './tools/get-notebook-summary.js';
// Artifacts
import { generateArtifactHandler } from './tools/generate-artifact.js';
import { listArtifactsHandler } from './tools/list-artifacts.js';
import { deleteArtifactHandler } from './tools/delete-artifact.js';
import { getArtifactContentHandler } from './tools/get-artifact-content.js';
// Research + Notes + Mind Maps
import { startResearchHandler } from './tools/start-research.js';
import { pollResearchHandler } from './tools/poll-research.js';
import { importResearchHandler } from './tools/import-research.js';
import { createNotebookNoteHandler } from './tools/create-notebook-note.js';
import { listNotebookNotesHandler } from './tools/list-notebook-notes.js';
import { updateNotebookNoteHandler } from './tools/update-notebook-note.js';
import { deleteNotebookNoteHandler } from './tools/delete-notebook-note.js';
import { generateMindMapHandler } from './tools/generate-mind-map.js';
import { saveLessonHandler } from './tools/save-lesson.js';
import { downloadArtifactHandler } from './tools/download-artifact.js';
// YouTube search
import { searchYoutubeHandler } from './tools/search-youtube.js';
import { youtubeChannelsHandler } from './tools/youtube-channels.js';
// Cross-notebook intelligence
import { searchAcrossNotebooksHandler } from './tools/search-across-notebooks.js';
import { recommendNotebooksHandler } from './tools/recommend-notebooks.js';
import { linkRelatedNotebooksHandler } from './tools/link-related-notebooks.js';

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
    platform: z.enum(['all', 'chatgpt', 'claude', 'claude-code', 'cli', 'gemini', 'notebooklm']).optional().default('all')
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

// --- Tool: query_token_stats ---
server.tool(
  'query_token_stats',
  'Show token count statistics for captured memories grouped by platform, speaker, or month. Shows coverage (counted vs total rows) and per-group breakdowns.',
  {
    days: z.number().optional().default(30).describe('Number of days to look back (default: 30)'),
    groupBy: z.enum(['platform', 'speaker', 'month']).optional().default('platform')
      .describe('Group stats by this dimension'),
  },
  async (args) => queryTokenStats(args),
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

// --- Tool: set_vault_pin ---
server.tool(
  'set_vault_pin',
  'Set or change the PIN on a vault project. Required before a vault can be activated. If the vault already has a PIN, the current PIN must be provided to change it.',
  {
    projectId: z.string().describe('Vault project UUID'),
    pin: z.string().describe('New PIN (min 4 characters)'),
    oldPin: z.string().optional().describe('Current PIN (required when changing an existing PIN)'),
  },
  async (args) => setVaultPin(args),
);

// --- Tool: list_notebooks ---
server.tool(
  'list_notebooks',
  'List NotebookLM notebooks with source counts and K.Y.T. project links.',
  {
    showMappings: z.boolean().optional().default(true).describe('Show K.Y.T. project mappings (default: true)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials (cached in memory after first use)'),
  },
  async (args) => listNotebooksHandler(args),
);

// --- Tool: create_notebook ---
server.tool(
  'create_notebook',
  'Create a new NotebookLM notebook and link it to the active K.Y.T. project.',
  {
    title: z.string().describe('Notebook title'),
    projectId: z.string().optional().describe('K.Y.T. project UUID to link (default: active project)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials (cached in memory after first use)'),
  },
  async (args) => createNotebookHandler(args),
);

// --- Tool: push_project_to_notebook ---
server.tool(
  'push_project_to_notebook',
  'Export K.Y.T. project conversations as NotebookLM sources. Groups by conversation, chunks at 50K chars, tracks for incremental push.',
  {
    projectId: z.string().optional().describe('K.Y.T. project UUID (default: active project)'),
    notebookId: z.string().optional().describe('NotebookLM notebook ID (default: from project mapping)'),
    maxSources: z.number().optional().default(50).describe('Max sources to upload in one run (default: 50)'),
    incremental: z.boolean().optional().default(true).describe('Skip already-pushed conversations (default: true)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials (cached in memory after first use)'),
  },
  async (args) => pushProjectToNotebookHandler(args),
);

// --- Tool: ask_notebook ---
server.tool(
  'ask_notebook',
  'Ask a question to a NotebookLM notebook. Returns a cited answer and optionally saves it to K.Y.T. as a research note.',
  {
    question: z.string().describe('Question to ask the notebook'),
    notebookId: z.string().optional().describe('NotebookLM notebook ID (default: from active project mapping)'),
    saveToKyt: z.boolean().optional().default(true).describe('Save answer to K.Y.T. as research note (default: true)'),
    projectId: z.string().optional().describe('K.Y.T. project UUID (default: active project)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials (cached in memory after first use)'),
  },
  async (args) => askNotebookHandler(args),
);

// --- Tool: add_source ---
server.tool(
  'add_source',
  'Add a source to a NotebookLM notebook. Supports text, URL, YouTube, and Google Drive sources.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    sourceType: z.enum(['text', 'url', 'youtube', 'gdrive']).describe('Source type'),
    title: z.string().optional().describe('Source title (used for text and gdrive)'),
    content: z.string().optional().describe('Text content (required for text sources)'),
    url: z.string().optional().describe('URL (required for url and youtube sources)'),
    fileId: z.string().optional().describe('Google Drive file ID (required for gdrive sources)'),
    mimeType: z.string().optional().describe('MIME type for gdrive sources (default: application/pdf)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => addSourceHandler(args),
);

// --- Tool: list_sources ---
server.tool(
  'list_sources',
  'List sources in a NotebookLM notebook with type, title, and URL.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => listSourcesHandler(args),
);

// --- Tool: delete_source ---
server.tool(
  'delete_source',
  'Delete a source from a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    sourceId: z.string().describe('Source ID to delete'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => deleteSourceHandler(args),
);

// --- Tool: get_source ---
server.tool(
  'get_source',
  'Get the full text content of a NotebookLM source.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    sourceId: z.string().describe('Source ID to read'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => getSourceHandler(args),
);

// --- Tool: rename_notebook ---
server.tool(
  'rename_notebook',
  'Rename a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    newTitle: z.string().describe('New notebook title'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => renameNotebookHandler(args),
);

// --- Tool: delete_notebook ---
server.tool(
  'delete_notebook',
  'Delete a NotebookLM notebook and remove its K.Y.T. mapping.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID to delete'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => deleteNotebookHandler(args),
);

// --- Tool: get_conversation_history ---
server.tool(
  'get_conversation_history',
  'Get the conversation history (Q&A turns) from a NotebookLM notebook.',
  {
    notebookId: z.string().optional().describe('NotebookLM notebook ID (default: from active project mapping)'),
    limit: z.number().optional().default(20).describe('Max turns to return (default: 20)'),
    saveToKyt: z.boolean().optional().default(false).describe('Save conversation to K.Y.T. as research (default: false)'),
    projectId: z.string().optional().describe('K.Y.T. project UUID (default: active project)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => getConversationHistoryHandler(args),
);

// --- Tool: get_notebook_summary ---
server.tool(
  'get_notebook_summary',
  'Get an AI-generated summary and topics from a NotebookLM notebook.',
  {
    notebookId: z.string().optional().describe('NotebookLM notebook ID (default: from active project mapping)'),
    saveToKyt: z.boolean().optional().default(false).describe('Save summary to K.Y.T. as research (default: false)'),
    projectId: z.string().optional().describe('K.Y.T. project UUID (default: active project)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => getNotebookSummaryHandler(args),
);

// --- Tool: generate_artifact ---
server.tool(
  'generate_artifact',
  'Generate an artifact in a NotebookLM notebook: audio, report, video, quiz, infographic, slide_deck, or data_table.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    type: z.enum(['audio', 'report', 'video', 'quiz', 'infographic', 'slide_deck', 'data_table'])
      .describe('Artifact type to generate'),
    sourceIds: z.array(z.string()).optional().describe('Source IDs to use (default: all sources)'),
    instructions: z.string().optional().describe('Custom instructions for generation'),
    format: z.string().optional().describe('Format option (audio: deep_dive/brief/critique/debate; video: lecture/documentary/explainer; slide_deck: presentation/summary)'),
    style: z.string().optional().describe('Style option (video: realistic/animated/whiteboard; infographic: modern/classic/minimal)'),
    length: z.string().optional().describe('Length option (audio: short/default/long; slide_deck: short/medium/long)'),
    variant: z.string().optional().describe('Quiz variant: quiz or flashcards'),
    quantity: z.string().optional().describe('Quiz quantity: few/standard/many'),
    difficulty: z.string().optional().describe('Quiz difficulty: easy/medium/hard'),
    orientation: z.string().optional().describe('Infographic orientation: portrait/landscape'),
    detail: z.string().optional().describe('Infographic detail level: simple/detailed'),
    language: z.string().optional().describe('Language code (default: en)'),
    waitForCompletion: z.boolean().optional().default(false).describe('Poll until artifact is ready (up to 120s)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => generateArtifactHandler(args),
);

// --- Tool: list_artifacts ---
server.tool(
  'list_artifacts',
  'List artifacts in a NotebookLM notebook with type, status, and title.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => listArtifactsHandler(args),
);

// --- Tool: delete_artifact ---
server.tool(
  'delete_artifact',
  'Delete an artifact from a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    artifactId: z.string().describe('Artifact ID to delete'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => deleteArtifactHandler(args),
);

// --- Tool: get_artifact_content ---
server.tool(
  'get_artifact_content',
  'Get the content of a NotebookLM artifact (structured quiz data, interactive HTML, etc.).',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    artifactId: z.string().describe('Artifact ID to read'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => getArtifactContentHandler(args),
);

// --- Tool: start_research ---
server.tool(
  'start_research',
  'Start a research task in a NotebookLM notebook. Fast research uses web search; deep research does comprehensive analysis.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    query: z.string().describe('Research query'),
    sourceType: z.enum(['web', 'drive']).optional().default('web').describe('Source type for research (default: web)'),
    deep: z.boolean().optional().default(false).describe('Use deep research mode (slower, more thorough)'),
    waitForCompletion: z.boolean().optional().default(false).describe('Poll until research completes'),
    saveToKyt: z.boolean().optional().default(true).describe('Save research results to K.Y.T.'),
    projectId: z.string().optional().describe('K.Y.T. project UUID (default: active project)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => startResearchHandler(args),
);

// --- Tool: poll_research ---
server.tool(
  'poll_research',
  'Poll the status of a research task in a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => pollResearchHandler(args),
);

// --- Tool: import_research ---
server.tool(
  'import_research',
  'Import research results as sources into a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    taskId: z.string().describe('Research task ID from start_research'),
    sources: z.array(z.object({
      url: z.string().describe('Source URL'),
      title: z.string().describe('Source title'),
    })).describe('Array of sources to import'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => importResearchHandler(args),
);

// --- Tool: create_notebook_note ---
server.tool(
  'create_notebook_note',
  'Create a note in a NotebookLM notebook. Different from save_note (which saves to K.Y.T. memory).',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    title: z.string().describe('Note title'),
    content: z.string().describe('Note content'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => createNotebookNoteHandler(args),
);

// --- Tool: list_notebook_notes ---
server.tool(
  'list_notebook_notes',
  'List notes and mind maps in a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => listNotebookNotesHandler(args),
);

// --- Tool: update_notebook_note ---
server.tool(
  'update_notebook_note',
  'Update a note in a NotebookLM notebook (title and/or content).',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    noteId: z.string().describe('Note ID to update'),
    title: z.string().optional().describe('New title'),
    content: z.string().optional().describe('New content'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => updateNotebookNoteHandler(args),
);

// --- Tool: delete_notebook_note ---
server.tool(
  'delete_notebook_note',
  'Delete a note from a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    noteId: z.string().describe('Note ID to delete'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => deleteNotebookNoteHandler(args),
);

// --- Tool: generate_mind_map ---
server.tool(
  'generate_mind_map',
  'Generate a mind map from sources in a NotebookLM notebook.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    sourceIds: z.array(z.string()).optional().describe('Source IDs to include (default: all sources)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => generateMindMapHandler(args),
);

// --- Tool: download_artifact ---
server.tool(
  'download_artifact',
  'Download a NotebookLM artifact. Text artifacts (report, mind map, data table, quiz, flashcards) return content inline. Binary artifacts (audio, video, slide deck, infographic) download to ~/.kyt/downloads/. Optionally saves to K.Y.T. memory.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID'),
    type: z.enum(['audio', 'video', 'slide_deck', 'report', 'mind_map', 'data_table', 'quiz', 'flashcards', 'infographic'])
      .describe('Artifact type to download'),
    artifactId: z.string().optional().describe('Specific artifact ID (default: latest of this type)'),
    format: z.string().optional().describe('Output format override: pptx (slide deck), markdown/html (quiz/flashcards)'),
    outputDir: z.string().optional().describe('Download directory (default: ~/.kyt/downloads/)'),
    saveToKyt: z.boolean().optional().default(true).describe('Save text content / metadata to K.Y.T. memory'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => downloadArtifactHandler(args),
);

// --- Tool: save_lesson ---
server.tool(
  'save_lesson',
  'Save a debugging lesson or non-obvious discovery to the Lessons Learned notebook. Call this when you discover something that took effort to figure out — future sessions will query these lessons before debugging. Dual-writes to NotebookLM (structured, queryable) and K.Y.T. memory (semantic search).',
  {
    category: z.enum([
      'api', 'parsing', 'auth', 'config', 'chrome_extension',
      'notebooklm', 'supabase', 'testing', 'performance', 'css',
      'javascript', 'node', 'database', 'networking', 'security', 'other',
    ]).describe('Lesson category'),
    error: z.string().describe('What went wrong — the symptom or unexpected behavior'),
    rootCause: z.string().optional().describe('Why it went wrong — the underlying cause'),
    solution: z.string().describe('What fixed it — the specific change or approach'),
    context: z.string().optional().describe('Files involved, project context, environment details'),
    tags: z.array(z.string()).optional().default([]).describe('Searchable tags'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => saveLessonHandler(args),
);

// --- Tool: search_youtube ---
server.tool(
  'search_youtube',
  'Discover YouTube videos via NotebookLM native research. Runs a YouTube-optimized web research query, waits for results, and extracts YouTube URLs. Use add_source to add selected videos. No API keys needed — uses Google\'s own infrastructure.',
  {
    notebookId: z.string().describe('NotebookLM notebook ID (research needs a notebook context)'),
    keywords: z.string().describe('Search keywords (required)'),
    channelId: z.string().optional().describe('Saved channel ID — resolves to channel name for query'),
    channelName: z.string().optional().describe('YouTube channel name to focus search on'),
    dateHint: z.string().optional().describe('Date hint: "recent", "this_month", "this_year", "2025", "2024", or freeform like "last 3 months"'),
    durationHint: z.enum(['short', 'medium', 'long']).optional().describe('Duration hint: short (<5m), medium (10-30m), long (>30m)'),
    deep: z.boolean().optional().default(false).describe('Use deep research (slower, more thorough, finds more videos)'),
    maxResults: z.number().optional().default(10).describe('Max YouTube results to extract (1-20)'),
    passphrase: z.string().optional().describe('Passphrase to decrypt NotebookLM credentials'),
  },
  async (args) => searchYoutubeHandler(args),
);

// --- Tool: youtube_channels ---
server.tool(
  'youtube_channels',
  'Save, list, or delete favorite YouTube channels for quick re-search. Bookmarks persist in ~/.kyt/notebooklm.json.',
  {
    action: z.enum(['list', 'save', 'delete']).describe('Action to perform'),
    channelId: z.string().optional().describe('YouTube channel ID (required for save/delete)'),
    channelName: z.string().optional().describe('Display name for the channel (required for save)'),
  },
  async (args) => youtubeChannelsHandler(args),
);

// --- Tool: search_across_notebooks ---
server.tool(
  'search_across_notebooks',
  'Search across multiple NotebookLM notebooks. Discovers relevant notebooks via title matching and K.Y.T. entity graph, then queries each for answers with citations and provenance.',
  {
    question: z.string().describe('Question to search across notebooks'),
    notebookIds: z.array(z.string()).optional().describe('Specific notebook IDs to query (skips discovery)'),
    maxNotebooks: z.number().optional().default(3).describe('Max notebooks to query (1-5, default: 3)'),
    saveToKyt: z.boolean().optional().default(true).describe('Save answers to K.Y.T. memory'),
    passphrase: z.string().optional().describe('Passphrase for NotebookLM credentials'),
  },
  async (args) => searchAcrossNotebooksHandler(args),
);

// --- Tool: recommend_notebooks ---
server.tool(
  'recommend_notebooks',
  'Find relevant notebooks for a topic without querying them. Fast discovery via title matching and entity graph (~200ms cached). Use search_across_notebooks to query the recommended notebooks.',
  {
    query: z.string().describe('Topic or question to find notebooks for'),
    maxResults: z.number().optional().default(10).describe('Max recommendations (default: 10)'),
    passphrase: z.string().optional().describe('Passphrase for NotebookLM credentials'),
  },
  async (args) => recommendNotebooksHandler(args),
);

// --- Tool: link_related_notebooks ---
server.tool(
  'link_related_notebooks',
  'Find notebooks related to a given notebook via title similarity and shared entities. Helps discover cross-notebook connections.',
  {
    notebookId: z.string().describe('Notebook ID to find related notebooks for'),
    maxResults: z.number().optional().default(5).describe('Max related notebooks (default: 5)'),
    passphrase: z.string().optional().describe('Passphrase for NotebookLM credentials'),
  },
  async (args) => linkRelatedNotebooksHandler(args),
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr (stdout is reserved for MCP JSON-RPC)
process.stderr.write('K.Y.T. MCP server started\n');

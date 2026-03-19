#!/usr/bin/env node
/**
 * Generate structured NotebookLM source documents from codebase files.
 *
 * Analyzes JS/TS files and produces markdown summaries with:
 * - File metadata (path, lines, language, subsystem)
 * - Purpose description
 * - Function-level block analysis with line ranges
 * - Exports, imports, dependencies
 * - Tags for cross-cutting queries
 * - Assessment notes (complexity, refactor suggestions)
 *
 * Usage:
 *   node scripts/generate-codebase-sources.js [--output docs/codebase-sources]
 *   node scripts/generate-codebase-sources.js --files src/browser-sync.js,background.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename, dirname, extname, relative } from 'path';

const ROOT = join(import.meta.dirname, '..');

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_OUTPUT = join(ROOT, 'docs', 'codebase-sources');

// Directories to scan (relative to ROOT)
const SCAN_DIRS = [
  'src',
  'platforms',
  'supabase/functions',
  'mcp/src',
];

// Root-level files to include
const ROOT_FILES = [
  'background.js',
  'manifest.json',
];

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', '.worktrees', '.git', 'dist', 'build',
  'tests', 'test', 'scripts', 'validation', '__tests__',
]);

// File extensions to analyze
const CODE_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.mts']);

// Subsystem detection from file path
const SUBSYSTEM_PATTERNS = [
  [/platforms\/chatgpt/i, 'chatgpt-capture'],
  [/platforms\/gemini/i, 'gemini-capture'],
  [/platforms\/claude/i, 'claude-capture'],
  [/platforms\/notebooklm/i, 'notebooklm-capture'],
  [/platforms\/base/i, 'platform-base'],
  [/history-import/i, 'history-import'],
  [/mcp\/src\/hooks/i, 'mcp-hooks'],
  [/mcp\/src\/tools/i, 'mcp-tools'],
  [/mcp\/src\/lib/i, 'mcp-lib'],
  [/supabase\/functions\/_shared/i, 'supabase-shared'],
  [/supabase\/functions/i, 'edge-functions'],
  [/auth/i, 'auth'],
  [/sync/i, 'sync'],
  [/search/i, 'search'],
  [/retrieval|context/i, 'retrieval'],
  [/embed/i, 'embeddings'],
  [/entity/i, 'entities'],
  [/queue/i, 'queue'],
  [/storage/i, 'storage'],
  [/utils?/i, 'utils'],
];

// Tag detection from content
const CONTENT_TAG_PATTERNS = [
  [/chrome\.storage/i, 'chrome-storage'],
  [/chrome\.runtime/i, 'chrome-runtime'],
  [/chrome\.alarms/i, 'chrome-alarms'],
  [/supabase/i, 'supabase'],
  [/embedding/i, 'embeddings'],
  [/circuit.?breaker/i, 'circuit-breaker'],
  [/dedup|deduplic/i, 'deduplication'],
  [/RLS|row.level.security/i, 'rls'],
  [/JWT|access.?token|refresh.?token/i, 'auth-tokens'],
  [/rate.?limit/i, 'rate-limiting'],
  [/XHR|XMLHttpRequest/i, 'xhr'],
  [/fetch\(/i, 'fetch-api'],
  [/MutationObserver/i, 'dom-observer'],
  [/WeakSet|WeakMap/i, 'weak-references'],
  [/crypto|encrypt|decrypt/i, 'crypto'],
  [/HyDE/i, 'hyde'],
  [/MMR|marginal.relevance/i, 'mmr'],
  [/RRF|reciprocal.rank/i, 'rrf'],
  [/Anthropic|claude/i, 'anthropic'],
  [/openai|gpt/i, 'openai'],
];

// ═══════════════════════════════════════════════════════════════════════
// FILE DISCOVERY
// ═══════════════════════════════════════════════════════════════════════

function discoverFiles() {
  const files = [];

  // Root-level files
  for (const f of ROOT_FILES) {
    const fullPath = join(ROOT, f);
    if (existsSync(fullPath)) files.push(fullPath);
  }

  // Scan directories
  for (const dir of SCAN_DIRS) {
    const fullDir = join(ROOT, dir);
    if (!existsSync(fullDir)) continue;
    walkDir(fullDir, files);
  }

  return files;
}

function walkDir(dir, files) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(fullPath, files);
    } else if (CODE_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CODE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════

function analyzeFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = relative(ROOT, filePath);
  const ext = extname(filePath);
  const lang = ext === '.ts' || ext === '.mts' ? 'TypeScript' : 'JavaScript';

  return {
    path: relPath,
    fullPath: filePath,
    lines: lines.length,
    language: lang,
    subsystem: detectSubsystem(relPath),
    imports: extractImports(lines),
    exports: extractExports(lines),
    functions: extractFunctions(lines, content),
    classes: extractClasses(lines, content),
    tags: detectTags(relPath, content),
    todos: extractTodos(lines),
    headerComment: extractHeaderComment(lines),
  };
}

function detectSubsystem(relPath) {
  for (const [pattern, subsystem] of SUBSYSTEM_PATTERNS) {
    if (pattern.test(relPath)) return subsystem;
  }
  return 'core';
}

function detectTags(relPath, content) {
  const tags = new Set();

  // From file extension
  if (relPath.endsWith('.ts')) tags.add('typescript');
  else tags.add('javascript');

  // From path
  if (relPath.includes('test') || relPath.includes('spec')) tags.add('test');
  if (relPath.includes('index.')) tags.add('entry-point');
  if (relPath.includes('migration')) tags.add('migration');

  // From content
  for (const [pattern, tag] of CONTENT_TAG_PATTERNS) {
    if (pattern.test(content)) tags.add(tag);
  }

  return [...tags].sort();
}

function extractImports(lines) {
  const imports = [];
  for (const line of lines) {
    // ES module imports
    const esMatch = line.match(/^\s*import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/);
    if (esMatch) {
      const names = esMatch[1] ? esMatch[1].split(',').map(s => s.trim()) : [esMatch[2]];
      imports.push({ names, from: esMatch[3] });
      continue;
    }
    // require
    const reqMatch = line.match(/(?:const|let|var)\s+(?:{([^}]+)}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (reqMatch) {
      const names = reqMatch[1] ? reqMatch[1].split(',').map(s => s.trim()) : [reqMatch[2]];
      imports.push({ names, from: reqMatch[3] });
    }
  }
  return imports;
}

function extractExports(lines) {
  const exports = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // export function/const/class
    const expMatch = line.match(/^\s*export\s+(?:(default)\s+)?(?:async\s+)?(function|const|let|class)\s+(\w+)/);
    if (expMatch) {
      exports.push({
        name: expMatch[3],
        type: expMatch[2],
        isDefault: !!expMatch[1],
        line: i + 1,
      });
      continue;
    }
    // module.exports
    const cjsMatch = line.match(/^\s*module\.exports\s*=\s*{?\s*(\w+)/);
    if (cjsMatch) {
      exports.push({ name: cjsMatch[1], type: 'cjs', line: i + 1 });
    }
  }
  return exports;
}

function extractFunctions(lines, content) {
  const functions = [];
  const funcPattern = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  const arrowPattern = /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(?([^)=]*)\)?\s*=>/;
  const methodPattern = /^(\s*)(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match = line.match(funcPattern) || line.match(arrowPattern);

    if (!match) {
      // Class methods — only if indented (not top-level) and named with valid identifier
      match = line.match(methodPattern);
      if (match) {
        const name = match[2];
        // Skip control flow, conditionals, and keywords that aren't function names
        const SKIP_NAMES = new Set([
          'if', 'else', 'for', 'while', 'switch', 'catch', 'try', 'finally',
          'do', 'return', 'throw', 'new', 'delete', 'typeof', 'void',
        ]);
        if (SKIP_NAMES.has(name) || match[1].length < 2) match = null;
      }
    }

    if (match) {
      const indent = match[1].length;
      const name = match[2];
      const params = match[3].trim();
      const startLine = i + 1;
      const endLine = findFunctionEnd(lines, i, indent);
      const bodyLines = endLine - startLine + 1;

      // Extract JSDoc/comment above
      const description = extractPrecedingComment(lines, i);

      functions.push({
        name,
        params,
        startLine,
        endLine,
        bodyLines,
        description,
        assessment: assessFunction(name, bodyLines, lines.slice(i, endLine)),
      });
    }
  }

  return functions;
}

function extractClasses(lines, content) {
  const classes = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    if (match) {
      const endLine = findFunctionEnd(lines, i, 0);
      classes.push({
        name: match[1],
        extends: match[2] || null,
        startLine: i + 1,
        endLine,
        bodyLines: endLine - i,
      });
    }
  }
  return classes;
}

function findFunctionEnd(lines, startIdx, baseIndent) {
  let braceCount = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { braceCount++; started = true; }
      if (ch === '}') braceCount--;
    }
    if (started && braceCount <= 0) return i + 1;
  }
  return Math.min(startIdx + 1, lines.length);
}

function extractPrecedingComment(lines, lineIdx) {
  const comments = [];
  for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 15); i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('/**') || trimmed.startsWith('//') || trimmed.startsWith('*/')) {
      comments.unshift(trimmed.replace(/^\/?\*+\s?|^\/\/\s?|^\*\/$/g, '').trim());
    } else if (trimmed === '') {
      continue; // Skip blank lines between comment and function
    } else {
      break;
    }
  }
  // Return first meaningful line of the comment
  const meaningful = comments.filter(c => c.length > 5);
  return meaningful.length > 0 ? meaningful[0] : null;
}

function extractTodos(lines) {
  const todos = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/\/\/\s*(TODO|FIXME|HACK|XXX|NOTE):\s*(.*)/i);
    if (match) {
      todos.push({ type: match[1].toUpperCase(), text: match[2].trim(), line: i + 1 });
    }
  }
  return todos;
}

function extractHeaderComment(lines) {
  const header = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('/**') || trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('*/')) {
      const clean = trimmed.replace(/^\/?\*+\s?|^\/\/\s?|^\*\/$/g, '').trim();
      if (clean) header.push(clean);
    } else if (trimmed === '' && header.length > 0) {
      break;
    } else if (!trimmed.startsWith('import') && trimmed !== '') {
      break;
    }
  }
  return header.join(' ').substring(0, 300) || null;
}

// ═══════════════════════════════════════════════════════════════════════
// ASSESSMENT ENGINE
// ═══════════════════════════════════════════════════════════════════════

function assessFunction(name, bodyLines, bodyContent) {
  const notes = [];

  // Length assessment
  if (bodyLines > 200) {
    notes.push('🔴 Very long (' + bodyLines + ' lines). Should be broken into smaller functions.');
  } else if (bodyLines > 100) {
    notes.push('🟡 Long (' + bodyLines + ' lines). Consider extracting sub-routines.');
  } else if (bodyLines > 50) {
    notes.push('🟡 Moderate length (' + bodyLines + ' lines).');
  }

  const bodyStr = bodyContent.join('\n');

  // Nesting depth
  const maxIndent = bodyContent.reduce((max, line) => {
    const match = line.match(/^(\s+)/);
    return Math.max(max, match ? match[1].length : 0);
  }, 0);
  if (maxIndent > 20) {
    notes.push('🟡 Deep nesting (indent ' + maxIndent + '). Consider early returns or extraction.');
  }

  // Try-catch count
  const tryCatches = (bodyStr.match(/\btry\s*\{/g) || []).length;
  if (tryCatches > 3) {
    notes.push('🟡 ' + tryCatches + ' try/catch blocks. Consider consolidating error handling.');
  }

  // Callback/promise nesting
  const callbacks = (bodyStr.match(/\.then\s*\(/g) || []).length;
  if (callbacks > 3) {
    notes.push('🟡 ' + callbacks + ' .then() chains. Consider async/await refactor.');
  }

  if (notes.length === 0) {
    notes.push('✅ Clean.');
  }

  return notes;
}

// ═══════════════════════════════════════════════════════════════════════
// MARKDOWN GENERATOR
// ═══════════════════════════════════════════════════════════════════════

function generateSourceMarkdown(analysis) {
  const lines = [];

  // Header
  lines.push(`# ${analysis.path}`);
  lines.push('');
  lines.push(`**Lines:** ${analysis.lines} | **Language:** ${analysis.language} | **Subsystem:** ${analysis.subsystem}`);
  lines.push(`**Tags:** ${analysis.tags.join(', ')}`);
  lines.push('');

  // Purpose
  if (analysis.headerComment) {
    lines.push('## Purpose');
    lines.push(analysis.headerComment);
    lines.push('');
  }

  // Imports (dependency graph)
  if (analysis.imports.length > 0) {
    lines.push('## Dependencies');
    for (const imp of analysis.imports) {
      const label = imp.from.startsWith('.') ? 'local' : 'external';
      lines.push(`- \`${imp.from}\` (${label}): ${imp.names.join(', ')}`);
    }
    lines.push('');
  }

  // Exports (public API)
  if (analysis.exports.length > 0) {
    lines.push('## Exports (Public API)');
    for (const exp of analysis.exports) {
      lines.push(`- **${exp.name}** (${exp.type}${exp.isDefault ? ', default' : ''}) — line ${exp.line}`);
    }
    lines.push('');
  }

  // Classes
  if (analysis.classes.length > 0) {
    lines.push('## Classes');
    for (const cls of analysis.classes) {
      lines.push(`### ${cls.name}${cls.extends ? ' extends ' + cls.extends : ''} [lines ${cls.startLine}-${cls.endLine}]`);
      lines.push(`${cls.bodyLines} lines`);
      lines.push('');
    }
  }

  // Functions (the core value)
  if (analysis.functions.length > 0) {
    lines.push('## Functions');
    lines.push('');
    for (const fn of analysis.functions) {
      const paramStr = fn.params ? `(${fn.params.substring(0, 80)})` : '()';
      lines.push(`### ${fn.name}${paramStr} [lines ${fn.startLine}-${fn.endLine}]`);
      if (fn.description) {
        lines.push(fn.description);
      }
      lines.push(`**Size:** ${fn.bodyLines} lines`);
      for (const note of fn.assessment) {
        lines.push(`**Assessment:** ${note}`);
      }
      lines.push('');
    }
  }

  // TODOs/FIXMEs
  if (analysis.todos.length > 0) {
    lines.push('## Notes & TODOs');
    for (const todo of analysis.todos) {
      lines.push(`- **${todo.type}** (line ${todo.line}): ${todo.text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);

  // Parse args
  let outputDir = DEFAULT_OUTPUT;
  let specificFiles = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) {
      outputDir = join(ROOT, args[++i]);
    } else if (args[i] === '--files' && args[i + 1]) {
      specificFiles = args[++i].split(',').map(f => join(ROOT, f.trim()));
    }
  }

  // Discover files
  const files = specificFiles || discoverFiles();
  console.log(`📁 Found ${files.length} code files to analyze`);

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Analyze and generate
  let totalFunctions = 0;
  let totalLines = 0;
  const summaries = [];

  for (const filePath of files) {
    try {
      const analysis = analyzeFile(filePath);
      const markdown = generateSourceMarkdown(analysis);

      // Write source document
      const safeFileName = analysis.path.replace(/[/\\]/g, '__') + '.md';
      const outPath = join(outputDir, safeFileName);
      writeFileSync(outPath, markdown);

      totalFunctions += analysis.functions.length;
      totalLines += analysis.lines;
      summaries.push({
        path: analysis.path,
        lines: analysis.lines,
        functions: analysis.functions.length,
        exports: analysis.exports.length,
        subsystem: analysis.subsystem,
        assessmentFlags: analysis.functions.filter(f => f.assessment.some(a => a.startsWith('🔴') || a.startsWith('🟡'))).length,
      });

      console.log(`  ✅ ${analysis.path} (${analysis.lines} lines, ${analysis.functions.length} functions)`);
    } catch (err) {
      console.error(`  ❌ ${relative(ROOT, filePath)}: ${err.message}`);
    }
  }

  // Generate index document
  const indexLines = [
    '# K.Y.T. Codebase Index',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Files:** ${summaries.length} | **Lines:** ${totalLines.toLocaleString()} | **Functions:** ${totalFunctions}`,
    '',
    '## Files by Subsystem',
    '',
  ];

  // Group by subsystem
  const bySubsystem = {};
  for (const s of summaries) {
    if (!bySubsystem[s.subsystem]) bySubsystem[s.subsystem] = [];
    bySubsystem[s.subsystem].push(s);
  }

  for (const [subsystem, files] of Object.entries(bySubsystem).sort()) {
    indexLines.push(`### ${subsystem}`);
    indexLines.push('| File | Lines | Functions | Exports | Flags |');
    indexLines.push('|------|-------|-----------|---------|-------|');
    for (const f of files.sort((a, b) => b.lines - a.lines)) {
      indexLines.push(`| ${f.path} | ${f.lines} | ${f.functions} | ${f.exports} | ${f.assessmentFlags > 0 ? '⚠️ ' + f.assessmentFlags : '✅'} |`);
    }
    indexLines.push('');
  }

  // Assessment summary
  const flaggedFiles = summaries.filter(s => s.assessmentFlags > 0);
  if (flaggedFiles.length > 0) {
    indexLines.push('## Assessment Summary');
    indexLines.push(`${flaggedFiles.length} files have functions flagged for review:`);
    for (const f of flaggedFiles.sort((a, b) => b.assessmentFlags - a.assessmentFlags)) {
      indexLines.push(`- **${f.path}** — ${f.assessmentFlags} function(s) flagged`);
    }
    indexLines.push('');
  }

  writeFileSync(join(outputDir, '_INDEX.md'), indexLines.join('\n'));

  console.log(`\n📊 Summary: ${summaries.length} files, ${totalLines.toLocaleString()} lines, ${totalFunctions} functions`);
  console.log(`📂 Output: ${outputDir}`);
  console.log(`📋 Index: ${join(outputDir, '_INDEX.md')}`);
}

main();

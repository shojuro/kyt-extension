/**
 * MCP tool: download_artifact
 *
 * Download a NotebookLM artifact via the Python CLI.
 * Text artifacts (report, mind map, data table, quiz, flashcards) return content inline.
 * Binary artifacts (audio, video, slide deck, infographic) download to disk.
 * Optionally saves text content to K.Y.T. as research.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { getActiveProjectId } from '../lib/config.js';
import { sanitize, wrapWithProvenance } from '../lib/notebooklm-sanitizer.js';
import { getNotebookMapping } from '../lib/notebooklm-config.js';

const DOWNLOAD_DIR = join(homedir(), '.kyt', 'downloads');

// CLI type names → file extensions
const TYPE_CONFIG = {
  audio:       { cli: 'audio',       ext: '.mp3',  binary: true  },
  video:       { cli: 'video',       ext: '.mp4',  binary: true  },
  slide_deck:  { cli: 'slide-deck',  ext: '.pdf',  binary: true  },
  infographic: { cli: 'infographic', ext: '.png',  binary: true  },
  report:      { cli: 'report',      ext: '.md',   binary: false },
  mind_map:    { cli: 'mind-map',    ext: '.json', binary: false },
  data_table:  { cli: 'data-table',  ext: '.csv',  binary: false },
  quiz:        { cli: 'quiz',        ext: '.json', binary: false },
  flashcards:  { cli: 'flashcards',  ext: '.json', binary: false },
};

/**
 * Sanitize a string for use as a filename.
 */
function sanitizeFilename(name) {
  return name
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 80);
}

/**
 * Validate output path — must be under allowed base dir, no traversal.
 */
function validatePath(outputPath, baseDir) {
  const resolved = resolve(outputPath);
  const resolvedBase = resolve(baseDir);
  if (!resolved.startsWith(resolvedBase)) {
    throw new Error(`Path traversal denied: ${outputPath} is outside ${baseDir}`);
  }
  return resolved;
}

export async function downloadArtifactHandler({
  notebookId, type, artifactId, format, outputDir, saveToKyt = true, passphrase,
}) {
  if (!isAuthConfigured()) {
    return {
      content: [{ type: 'text', text: 'NotebookLM auth not configured.' }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);

  if (!notebookId) {
    return { content: [{ type: 'text', text: 'Error: notebookId is required.' }], isError: true };
  }

  const config = TYPE_CONFIG[type];
  if (!config) {
    return {
      content: [{ type: 'text', text: `Error: type must be one of: ${Object.keys(TYPE_CONFIG).join(', ')}` }],
      isError: true,
    };
  }

  // Validate notebook ID format
  if (!/^[0-9a-f-]{36}$/i.test(notebookId)) {
    return { content: [{ type: 'text', text: 'Error: invalid notebook ID format.' }], isError: true };
  }

  try {
    // Determine output path
    const baseDir = outputDir || DOWNLOAD_DIR;
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });

    // Choose file extension based on format override
    let ext = config.ext;
    if (format === 'pptx' && type === 'slide_deck') ext = '.pptx';
    if (format === 'markdown' && (type === 'quiz' || type === 'flashcards')) ext = '.md';
    if (format === 'html' && (type === 'quiz' || type === 'flashcards')) ext = '.html';

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `${sanitizeFilename(config.cli)}_${timestamp}${ext}`;
    const outputPath = validatePath(join(baseDir, filename), baseDir);

    // Sync auth to Python CLI before download
    // (Python CLI uses ~/.notebooklm/storage_state.json, MCP uses ~/.kyt/notebooklm-auth.enc)
    try {
      const { getAuth } = await import('../lib/notebooklm-auth.js');
      const passphrase = (await import('../lib/notebooklm-client.js')).hasPassphrase()
        ? undefined : null;
      const auth = await getAuth(passphrase !== null ? passphrase : process.env.NOTEBOOKLM_PASSPHRASE, true);
      const cookies = auth.cookieHeader.split('; ').map(pair => {
        const [name, ...rest] = pair.split('=');
        return { name, value: rest.join('='), domain: '.google.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
      });
      const nlmDir = join(homedir(), '.notebooklm');
      if (!existsSync(nlmDir)) mkdirSync(nlmDir, { recursive: true });
      const { writeFileSync: wf } = await import('fs');
      wf(join(nlmDir, 'storage_state.json'), JSON.stringify({ cookies, origins: [] }, null, 2));
    } catch { /* non-critical — CLI may already have valid auth */ }

    // Build CLI command
    const args = ['download', config.cli, outputPath];
    if (artifactId) {
      if (!/^[0-9a-f-]{36}$/i.test(artifactId)) {
        return { content: [{ type: 'text', text: 'Error: invalid artifact ID format.' }], isError: true };
      }
      args.push('-a', artifactId);
    }
    args.push('-n', notebookId);
    if (format) args.push('--format', format);

    // Execute download
    const output = execFileSync('notebooklm', args, {
      timeout: 120000, // 2 min for large files
      encoding: 'utf-8',
    });

    if (!existsSync(outputPath)) {
      return {
        content: [{ type: 'text', text: `Download command ran but file not created at ${outputPath}. CLI output: ${output.substring(0, 200)}` }],
        isError: true,
      };
    }

    const lines = [];

    if (config.binary) {
      // Binary artifact — return path + metadata
      const stat = statSync(outputPath);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      lines.push(`Downloaded ${type} artifact.`);
      lines.push(`File: ${outputPath}`);
      lines.push(`Size: ${sizeMB} MB`);

      // Save metadata to K.Y.T. if requested
      if (saveToKyt) {
        try {
          const userId = getUserId();
          const mapping = getNotebookMapping(notebookId);
          const notebookTitle = mapping?.title || notebookId;
          const metaContent = `[Downloaded ${type} artifact from NotebookLM notebook '${notebookTitle}']\nFile: ${outputPath}\nSize: ${sizeMB} MB\nType: ${type}\nFormat: ${ext}`;

          await callEdgeFunction('save_chat_turn_batch', {
            userId,
            turns: [{
              content: metaContent,
              platform: 'notebooklm',
              conversation_id: `nlm-download-${notebookId}`,
              speakers: ['assistant'],
              content_type: 'research',
            }],
            project_id: getActiveProjectId() || undefined,
          });
          lines.push('Metadata saved to K.Y.T.');
        } catch (saveErr) {
          lines.push(`Warning: K.Y.T. save failed: ${saveErr.message}`);
        }
      }
    } else {
      // Text artifact — return content inline
      const rawContent = readFileSync(outputPath, 'utf-8');
      const sanitizedContent = sanitize(rawContent);

      lines.push(`Downloaded ${type} artifact (${rawContent.length} chars).`);
      lines.push(`File: ${outputPath}`);
      lines.push('');

      // Truncate for MCP response (full content in file)
      if (sanitizedContent.length > 5000) {
        lines.push(sanitizedContent.substring(0, 5000));
        lines.push(`\n... (truncated, ${sanitizedContent.length} chars total — full content in file)`);
      } else {
        lines.push(sanitizedContent);
      }

      // Save full content to K.Y.T. if requested
      if (saveToKyt) {
        try {
          const userId = getUserId();
          const mapping = getNotebookMapping(notebookId);
          const notebookTitle = mapping?.title || notebookId;

          // Cap at 100K chars for K.Y.T. save (M1 mitigation)
          const kytContent = sanitizedContent.length > 100000
            ? sanitizedContent.substring(0, 100000) + '\n\n[Truncated at 100K chars]'
            : sanitizedContent;
          const wrapped = wrapWithProvenance(kytContent, notebookTitle);

          await callEdgeFunction('save_chat_turn_batch', {
            userId,
            turns: [{
              content: wrapped,
              platform: 'notebooklm',
              conversation_id: `nlm-artifact-${notebookId}`,
              speakers: ['assistant'],
              content_type: 'research',
            }],
            project_id: getActiveProjectId() || undefined,
          });
          lines.push('\nSaved to K.Y.T. as research note.');
        } catch (saveErr) {
          lines.push(`\nWarning: K.Y.T. save failed: ${saveErr.message}`);
        }
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error downloading artifact: ${err.message}` }],
      isError: true,
    };
  }
}

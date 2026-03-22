/**
 * MCP tool: start_research
 *
 * Start a research task in a NotebookLM notebook (fast or deep).
 * Optionally saves summary to K.Y.T.
 */

import { startResearch, pollResearch, importResearch, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { sanitize, wrapWithProvenance } from '../lib/notebooklm-sanitizer.js';
import { getNotebookMapping } from '../lib/notebooklm-config.js';

export async function startResearchHandler({
  notebookId, query, sourceType = 'web', deep = false,
  waitForCompletion = false, saveToKyt = true, projectId, passphrase,
}) {
  if (!isAuthConfigured()) {
    return {
      content: [{ type: 'text', text: 'NotebookLM auth not configured. Use the login flow or import cookies first.' }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{ type: 'text', text: 'Passphrase required. Pass `passphrase` parameter.' }],
      isError: true,
    };
  }

  if (!notebookId || !query) {
    return {
      content: [{ type: 'text', text: 'Error: notebookId and query are required.' }],
      isError: true,
    };
  }

  const sourceTypeCode = sourceType === 'drive' ? 2 : 1;

  try {
    const { taskId } = await startResearch(notebookId, query, sourceTypeCode, deep);

    const lines = [
      `Research started (${deep ? 'deep' : 'fast'}).`,
      `Query: ${query}`,
      `Task ID: ${taskId || '(unknown)'}`,
    ];

    // Poll for completion if requested
    if (waitForCompletion) {
      lines.push('', 'Waiting for completion...');
      const maxWaitMs = deep ? 300_000 : 120_000;
      const intervalMs = 5_000;
      const deadline = Date.now() + maxWaitMs;

      let finalResult = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, intervalMs));
        const poll = await pollResearch(notebookId, taskId);
        if (poll.done && poll.sources && poll.sources.length > 0) {
          finalResult = poll;
          break;
        }
        if (poll.done) {
          // Done but sources not yet available — keep polling briefly
          if (Date.now() + 30_000 > deadline) { finalResult = poll; break; }
        }
      }

      if (finalResult) {
        lines.push(`Status: ${finalResult.statusLabel}`);

        // Auto-import sources into notebook
        if (finalResult.sources && finalResult.sources.length > 0) {
          const webSources = finalResult.sources.filter(s => s.type === 'web' && s.url);
          if (webSources.length > 0) {
            try {
              await importResearch(notebookId, finalResult.taskId, webSources);
              lines.push(`\nAuto-imported ${webSources.length} source(s) into notebook.`);
            } catch (importErr) {
              lines.push(`\nWarning: Auto-import failed: ${importErr.message}`);
              lines.push('Use import_research to add sources manually.');
            }
          }
          lines.push(`Sources found: ${finalResult.sources.length} (${webSources.length} web)`);
        }

        if (finalResult.summary) {
          const sanitizedSummary = sanitize(finalResult.summary);
          lines.push('', '**Research Summary:**', sanitizedSummary);

          // Save to K.Y.T.
          if (saveToKyt) {
            try {
              const userId = getUserId();
              const mapping = getNotebookMapping(notebookId);
              const notebookTitle = mapping?.title || notebookId;
              const content = `Research query: ${query}\n\n${sanitizedSummary}`;
              const wrapped = wrapWithProvenance(content, notebookTitle);

              await callEdgeFunction('save_chat_turn_batch', {
                userId,
                messages: [{
                  content: wrapped,
                  platform: 'notebooklm',
                  conversationId: `nlm-research-${notebookId}`,
                  speakers: ['user', 'assistant'],
                  contentType: 'research',
                }],
                projectId: projectId || undefined,
              });
              lines.push('\nSaved to K.Y.T. as research note.');
            } catch (saveErr) {
              lines.push(`\nWarning: Failed to save to K.Y.T.: ${saveErr.message}`);
            }
          }
        }
      } else {
        lines.push('Timed out waiting for research to complete. Use poll_research to check status.');
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error starting research: ${err.message}` }],
      isError: true,
    };
  }
}

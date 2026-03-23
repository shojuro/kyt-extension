/**
 * MCP tool: ask_notebook
 *
 * Ask a question to a NotebookLM notebook. Optionally saves the cited answer
 * back to K.Y.T. as content_type: 'research'.
 */

import { askQuestion, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { getNotebookForProject, getNotebookMapping } from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getActiveProjectId } from '../lib/config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { sanitize, wrapWithProvenance, detectInjection } from '../lib/notebooklm-sanitizer.js';

export async function askNotebookHandler({ question, notebookId, saveToKyt = true, projectId, passphrase }) {
  if (!isAuthConfigured()) {
    return {
      content: [{
        type: 'text',
        text: 'NotebookLM auth not configured. Use the login flow or import cookies first.',
      }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{
        type: 'text',
        text: 'Passphrase required to decrypt NotebookLM credentials. Pass `passphrase` parameter.',
      }],
      isError: true,
    };
  }

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: question is required.' }],
      isError: true,
    };
  }

  // Resolve notebook
  const resolvedProjectId = projectId || getActiveProjectId();
  const resolvedNotebookId = notebookId || (resolvedProjectId ? getNotebookForProject(resolvedProjectId) : null);

  if (!resolvedNotebookId) {
    return {
      content: [{
        type: 'text',
        text: 'Error: No notebook specified and no notebook linked to active project. Pass notebookId or link a project first.',
      }],
      isError: true,
    };
  }

  try {
    // Ask NotebookLM
    const { answer, citations } = await askQuestion(resolvedNotebookId, question.trim());

    if (!answer) {
      return {
        content: [{ type: 'text', text: 'NotebookLM returned no answer. The notebook may have no sources yet.' }],
      };
    }

    // Sanitize
    const { hasInjection, patterns } = detectInjection(answer);
    const sanitizedAnswer = sanitize(answer);

    // Format citations
    const citationLines = citations.map((c, i) =>
      `[${i + 1}] ${c.cited_text?.slice(0, 200) || '(no text)'}${c.source_id ? ` (source: ${c.source_id})` : ''}`
    );

    // Build formatted content for K.Y.T.
    const mapping = getNotebookMapping(resolvedNotebookId);
    const notebookTitle = mapping?.title || resolvedNotebookId;
    const formattedContent = [
      `Q: ${question.trim()}`,
      '',
      `A: ${sanitizedAnswer}`,
      '',
      ...(citationLines.length > 0 ? ['Citations:', ...citationLines] : []),
    ].join('\n');

    // Save to K.Y.T. if requested
    let saveResult = null;
    if (saveToKyt) {
      try {
        const userId = getUserId();
        const wrappedContent = wrapWithProvenance(formattedContent, notebookTitle);

        saveResult = await callEdgeFunction('save_chat_turn_batch', {
          userId,
          messages: [{
            content: wrappedContent,
            platform: 'notebooklm',
            conversationId: `nlm-${resolvedNotebookId}`,
            speakers: ['user', 'assistant'],
            contentType: 'research',
            metadata: {
              notebooklm: {
                notebook_id: resolvedNotebookId,
                question: question.trim(),
                citations: citations.map(c => ({
                  source_id: c.source_id,
                  cited_text: c.cited_text,
                  start_char: c.start_char,
                  end_char: c.end_char,
                })),
              },
            },
          }],
          projectId: resolvedProjectId || undefined,
        });
      } catch (saveErr) {
        saveResult = { error: saveErr.message };
      }
    }

    // Build response
    const lines = [
      `**Answer from NotebookLM** (${notebookTitle}):`,
      '',
      sanitizedAnswer,
    ];

    if (citationLines.length > 0) {
      lines.push('', '**Citations:**', ...citationLines);
    }

    if (hasInjection) {
      lines.push('', `Warning: Injection patterns detected and sanitized: ${patterns.join(', ')}`);
    }

    if (saveToKyt) {
      if (saveResult?.error) {
        lines.push('', `Warning: Failed to save to K.Y.T.: ${saveResult.error}`);
      } else {
        lines.push('', 'Saved to K.Y.T. as research note (content_type: research, platform: notebooklm)');
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error querying notebook: ${err.message}` }],
      isError: true,
    };
  }
}

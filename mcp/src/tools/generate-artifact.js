/**
 * MCP tool: generate_artifact
 *
 * Generate an artifact in a NotebookLM notebook.
 * Supports: audio, report, video, quiz, infographic, slide_deck, data_table.
 */

import {
  generateArtifact, listArtifacts, listSources,
  setPassphrase, hasPassphrase,
} from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { ARTIFACT_TYPE } from '../lib/notebooklm-constants.js';

const TYPE_MAP = {
  audio: ARTIFACT_TYPE.AUDIO,
  report: ARTIFACT_TYPE.REPORT,
  video: ARTIFACT_TYPE.VIDEO,
  quiz: ARTIFACT_TYPE.QUIZ,
  infographic: ARTIFACT_TYPE.INFOGRAPHIC,
  slide_deck: ARTIFACT_TYPE.SLIDE_DECK,
  data_table: ARTIFACT_TYPE.DATA_TABLE,
};

export async function generateArtifactHandler({
  notebookId, type, sourceIds, instructions, format, style, length,
  quantity, difficulty, variant, orientation, detail, language,
  waitForCompletion = false, passphrase,
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

  if (!notebookId) {
    return { content: [{ type: 'text', text: 'Error: notebookId is required.' }], isError: true };
  }

  const typeCode = TYPE_MAP[type];
  if (!typeCode) {
    return {
      content: [{ type: 'text', text: `Error: type must be one of: ${Object.keys(TYPE_MAP).join(', ')}` }],
      isError: true,
    };
  }

  try {
    // If no sourceIds provided, use all sources in notebook
    let resolvedSourceIds = sourceIds;
    if (!resolvedSourceIds || resolvedSourceIds.length === 0) {
      const sources = await listSources(notebookId);
      resolvedSourceIds = sources.map(s => s.id);
      if (resolvedSourceIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: Notebook has no sources. Add sources before generating artifacts.' }],
          isError: true,
        };
      }
    }

    const options = { instructions, format, style, length, quantity, difficulty, variant, orientation, detail, language };
    // Remove undefined values
    for (const key of Object.keys(options)) {
      if (options[key] === undefined) delete options[key];
    }

    const { artifactId, taskId } = await generateArtifact(notebookId, typeCode, resolvedSourceIds, options);

    const lines = [
      `Artifact generation started.`,
      `Type: ${type}`,
      `Artifact ID: ${artifactId || '(pending)'}`,
      `Task ID: ${taskId || '(unknown)'}`,
      `Sources: ${resolvedSourceIds.length}`,
    ];

    // Poll for completion if requested
    if (waitForCompletion && artifactId) {
      lines.push('', 'Waiting for completion...');
      const maxWaitMs = 120_000;
      const intervalMs = 5_000;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, intervalMs));
        const artifacts = await listArtifacts(notebookId);
        const match = artifacts.find(a => a.id === artifactId);
        if (match && (match.status === 3 || match.status === 4)) {
          lines.push(`Status: ${match.statusLabel}`);
          if (match.status === 4) {
            lines.push('Artifact generation failed.');
          }
          break;
        }
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error generating artifact: ${err.message}` }],
      isError: true,
    };
  }
}

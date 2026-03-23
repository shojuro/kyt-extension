/**
 * MCP tool: search_youtube
 *
 * Discover YouTube videos via NotebookLM's native research feature.
 * Uses Google's own infrastructure — no third-party APIs, no keys, no quota.
 *
 * Flow: Constructs a YouTube-optimized research query → runs NotebookLM
 * fast/deep research → filters results for YouTube URLs → returns structured list.
 *
 * Requires a NotebookLM notebook as the research context.
 */

import { startResearch, pollResearch, importResearch, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { sanitize } from '../lib/notebooklm-sanitizer.js';
import { getYoutubeChannels } from '../lib/notebooklm-config.js';

const YOUTUBE_URL_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/g;

/**
 * Build a YouTube-optimized research query from user params.
 */
function buildQuery({ keywords, channelName, dateHint, durationHint }) {
  const parts = [`YouTube videos about: ${keywords}`];

  if (channelName) {
    parts.push(`from channel "${channelName}"`);
  }

  if (dateHint) {
    const dateMap = {
      'recent': 'uploaded in the last week',
      'this_month': 'uploaded this month',
      'this_year': 'uploaded this year',
      '2025': 'uploaded in 2025',
      '2024': 'uploaded in 2024',
    };
    parts.push(dateMap[dateHint] || `uploaded ${dateHint}`);
  }

  if (durationHint) {
    const durMap = {
      'short': 'short videos under 5 minutes',
      'medium': 'medium-length videos 10-30 minutes',
      'long': 'long-form videos over 30 minutes',
    };
    parts.push(durMap[durationHint] || durationHint);
  }

  // Always ask for YouTube specifically
  parts.push('— include YouTube video URLs with titles');

  return parts.join(' ');
}

/**
 * Extract YouTube URLs and associated text from research summary.
 */
function extractYoutubeResults(summary) {
  if (!summary) return [];

  const results = [];
  const lines = summary.split('\n');
  const urlSet = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = [...line.matchAll(YOUTUBE_URL_RE)];

    for (const match of matches) {
      const videoId = match[1];
      if (urlSet.has(videoId)) continue;
      urlSet.add(videoId);

      const url = `https://www.youtube.com/watch?v=${videoId}`;

      // Try to extract title: look at the line context around the URL
      let title = '';
      // Check if there's text before the URL on this line
      const urlIdx = line.indexOf(match[0]);
      const before = line.slice(0, urlIdx).replace(/[-–—•*\[\]()]/g, '').trim();
      if (before.length > 5 && before.length < 200) {
        title = before;
      }
      // Or check the previous line for a title
      if (!title && i > 0) {
        const prevLine = lines[i - 1].replace(/[-–—•*\[\]()#]/g, '').trim();
        if (prevLine.length > 5 && prevLine.length < 200 && !prevLine.match(YOUTUBE_URL_RE)) {
          title = prevLine;
        }
      }

      results.push({
        videoId,
        url,
        title: sanitize(title || `Video ${videoId}`),
      });
    }
  }

  return results;
}

export async function searchYoutubeHandler({
  notebookId, keywords, channelId, channelName, dateHint, durationHint,
  deep = false, maxResults, passphrase,
}) {
  // Auth checks
  if (!isAuthConfigured()) {
    return {
      content: [{ type: 'text', text: 'NotebookLM auth not configured. Use the login flow or import cookies first.' }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{ type: 'text', text: 'Auth unavailable. Import cookies first (auto-key handles encryption), or pass `passphrase` to override.' }],
      isError: true,
    };
  }

  if (!notebookId) {
    return {
      content: [{ type: 'text', text: 'Error: notebookId is required (research needs a notebook context).' }],
      isError: true,
    };
  }

  if (!keywords || typeof keywords !== 'string' || keywords.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: keywords is required.' }],
      isError: true,
    };
  }

  // Resolve channelName from bookmarks if channelId provided
  let resolvedChannelName = channelName;
  if (channelId && !channelName) {
    const channels = getYoutubeChannels();
    const found = channels.find(c => c.channelId === channelId);
    if (found) resolvedChannelName = found.channelName;
  }

  const query = buildQuery({
    keywords: keywords.trim(),
    channelName: resolvedChannelName,
    dateHint,
    durationHint,
  });

  const clampedMax = Math.min(Math.max(typeof maxResults === 'number' ? maxResults : 10, 1), 20);

  try {
    // Start research
    const { taskId } = await startResearch(notebookId, query, /* sourceType web */ 1, deep);

    const lines = [
      `**YouTube Search** via NotebookLM ${deep ? 'deep' : 'fast'} research`,
      `Query: ${query}`,
      '',
      'Waiting for results...',
    ];

    // Poll for completion
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

    if (!finalResult) {
      return {
        content: [{
          type: 'text',
          text: `Research started (task ${taskId}) but didn't complete within timeout. Use poll_research to check status.`,
        }],
      };
    }

    // Auto-import all sources into notebook
    let importedCount = 0;
    if (finalResult.sources && finalResult.sources.length > 0) {
      const webSources = finalResult.sources.filter(s => s.type === 'web' && s.url);
      if (webSources.length > 0) {
        try {
          await importResearch(notebookId, finalResult.taskId, webSources);
          importedCount = webSources.length;
        } catch {
          // Import failed — still show results, user can import manually
        }
      }
    }

    // Extract YouTube URLs from sources (more reliable than summary parsing)
    const ytFromSources = (finalResult.sources || [])
      .filter(s => s.url && (s.url.includes('youtube.com') || s.url.includes('youtu.be')))
      .map(s => {
        const match = s.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{11})/);
        return match ? { videoId: match[1], url: s.url, title: sanitize(s.title || `Video ${match[1]}`) } : null;
      })
      .filter(Boolean);

    // Also extract from summary text as fallback
    const summary = finalResult.summary || '';
    const ytFromSummary = extractYoutubeResults(summary);

    // Merge, deduplicate by videoId
    const seen = new Set();
    const ytResults = [];
    for (const v of [...ytFromSources, ...ytFromSummary]) {
      if (!seen.has(v.videoId)) {
        seen.add(v.videoId);
        ytResults.push(v);
      }
    }
    const clampedResults = ytResults.slice(0, clampedMax);

    lines.length = 0; // Clear the waiting lines

    if (clampedResults.length === 0) {
      lines.push(`**YouTube Search** — "${keywords.trim()}"`, '');
      lines.push('No YouTube videos found in research results.');
      if (finalResult.sources && finalResult.sources.length > 0) {
        lines.push(`(${finalResult.sources.length} web sources found and ${importedCount > 0 ? 'auto-imported' : 'queued'} — none are YouTube)`);
      }
      lines.push('', 'The research summary may still contain useful context:');
      lines.push('', sanitize(summary).slice(0, 500));
    } else {
      lines.push(`**YouTube Search Results** — "${keywords.trim()}"`, '');
      lines.push(`Found ${clampedResults.length} YouTube video${clampedResults.length !== 1 ? 's' : ''}:`, '');

      for (const [i, v] of clampedResults.entries()) {
        lines.push(`${String(i + 1).padStart(2)}. ${v.title}`);
        lines.push(`    ${v.url}`, '');
      }

      if (importedCount > 0) {
        lines.push(`---`);
        lines.push(`Auto-imported ${importedCount} source(s) into notebook.`);
      }

      lines.push('To add a specific video: add_source sourceType:"youtube" url:"<url>" notebookId:"<id>"');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error searching YouTube: ${err.message}` }],
      isError: true,
    };
  }
}

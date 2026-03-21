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

import { startResearch, pollResearch, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
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
      content: [{ type: 'text', text: 'Passphrase required. Pass `passphrase` parameter.' }],
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
      const poll = await pollResearch(notebookId);
      if (poll.done) {
        finalResult = poll;
        break;
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

    // Extract YouTube URLs from research summary
    const summary = finalResult.summary || '';
    const ytResults = extractYoutubeResults(summary).slice(0, clampedMax);

    lines.length = 0; // Clear the waiting lines

    if (ytResults.length === 0) {
      lines.push(`**YouTube Search** — "${keywords.trim()}"`, '');
      lines.push('No YouTube videos found in research results.');
      lines.push('', 'The research summary may still contain useful context:');
      lines.push('', sanitize(summary).slice(0, 500));

      // Also show the importable sources from research
      if (finalResult.sources && finalResult.sources.length > 0) {
        const ytSources = finalResult.sources.filter(s =>
          s.url && (s.url.includes('youtube.com') || s.url.includes('youtu.be'))
        );
        if (ytSources.length > 0) {
          lines.push('', '**YouTube sources found in research:**', '');
          for (const [i, s] of ytSources.entries()) {
            lines.push(`${i + 1}. ${sanitize(s.title || 'Untitled')}`);
            lines.push(`   ${s.url}`, '');
          }
          lines.push('Use import_research to add these as notebook sources, or add_source sourceType:"youtube" url:"<url>"');
        }
      }
    } else {
      lines.push(`**YouTube Search Results** — "${keywords.trim()}"`, '');
      lines.push(`Found ${ytResults.length} YouTube video${ytResults.length !== 1 ? 's' : ''}:`, '');

      for (const [i, v] of ytResults.entries()) {
        lines.push(`${String(i + 1).padStart(2)}. ${v.title}`);
        lines.push(`    ${v.url}`, '');
      }

      // Also show non-YouTube sources from research
      if (finalResult.sources && finalResult.sources.length > 0) {
        const ytSources = finalResult.sources.filter(s =>
          s.url && (s.url.includes('youtube.com') || s.url.includes('youtu.be'))
        );
        if (ytSources.length > ytResults.length) {
          lines.push('**Additional YouTube sources from research:**', '');
          for (const s of ytSources) {
            if (!ytResults.some(r => s.url?.includes(r.videoId))) {
              lines.push(`  • ${sanitize(s.title || 'Untitled')} — ${s.url}`);
            }
          }
          lines.push('');
        }
      }

      lines.push('---');
      lines.push('To add a video: add_source sourceType:"youtube" url:"<url>" notebookId:"<id>"');
      lines.push('To import all research sources: import_research notebookId:"<id>" taskId:"' + (taskId || '') + '"');
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

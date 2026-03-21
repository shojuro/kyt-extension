/**
 * MCP tool: youtube_channels
 *
 * Save, list, or delete favorite YouTube channels for quick re-search.
 * Bookmarks stored in ~/.kyt/notebooklm.json under youtubeChannels key.
 */

import {
  getYoutubeChannels,
  saveYoutubeChannel,
  deleteYoutubeChannel,
} from '../lib/notebooklm-config.js';

export async function youtubeChannelsHandler({ action, channelId, channelName }) {
  if (!action || !['list', 'save', 'delete'].includes(action)) {
    return {
      content: [{ type: 'text', text: 'Error: action must be one of: list, save, delete.' }],
      isError: true,
    };
  }

  try {
    if (action === 'list') {
      const channels = getYoutubeChannels();
      if (channels.length === 0) {
        return {
          content: [{ type: 'text', text: 'No saved YouTube channels. Use action:"save" to add one.' }],
        };
      }

      const lines = ['**Saved YouTube Channels**', ''];
      for (const ch of channels) {
        lines.push(`• ${ch.channelName} (${ch.channelId}) — saved ${ch.savedAt?.split('T')[0] || 'unknown'}`);
      }
      lines.push('', 'Use search_youtube with channelId to search within a specific channel.');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }

    if (action === 'save') {
      if (!channelId) {
        return {
          content: [{ type: 'text', text: 'Error: channelId is required for save.' }],
          isError: true,
        };
      }
      if (!channelName) {
        return {
          content: [{ type: 'text', text: 'Error: channelName is required for save.' }],
          isError: true,
        };
      }

      saveYoutubeChannel(channelId, channelName);
      return {
        content: [{ type: 'text', text: `Channel saved: ${channelName} (${channelId})` }],
      };
    }

    if (action === 'delete') {
      if (!channelId) {
        return {
          content: [{ type: 'text', text: 'Error: channelId is required for delete.' }],
          isError: true,
        };
      }

      const deleted = deleteYoutubeChannel(channelId);
      return {
        content: [{
          type: 'text',
          text: deleted
            ? `Channel removed: ${channelId}`
            : `Channel not found: ${channelId}`,
        }],
      };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error managing channels: ${err.message}` }],
      isError: true,
    };
  }
}

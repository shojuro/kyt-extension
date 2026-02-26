// memories.js — K.Y.T. Memory Management Page

const PAGE_SIZE = 50;
let currentOffset = 0;
let totalConversations = 0;
let conversations = [];
let pendingDeleteId = null;

// DOM refs
const conversationList = document.getElementById('conversationList');
const loadMoreContainer = document.getElementById('loadMoreContainer');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const emptyState = document.getElementById('emptyState');
const totalCount = document.getElementById('totalCount');
const deleteAllBtn = document.getElementById('deleteAllBtn');
const deleteModal = document.getElementById('deleteModal');
const deleteModalTitle = document.getElementById('deleteModalTitle');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');
const deleteConfirmBtn = document.getElementById('deleteConfirmBtn');

// ===== Formatting =====

function formatDate(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function platformIcon(platform, isImported) {
  if (isImported) return '📥';
  if (platform === 'chatgpt') return '🟢';
  if (platform === 'claude') return '🟣';
  return '⬜';
}

function platformClass(platform, isImported) {
  if (isImported) return 'imported';
  return platform || 'cli';
}

// ===== Rendering =====

function renderConversation(conv) {
  const row = document.createElement('div');
  row.className = `conversation-row${conv.exclude_from_search ? ' excluded' : ''}`;
  row.dataset.externalId = conv.external_id;

  const title = conv.title || 'Untitled conversation';
  const turns = conv.turn_count || conv.message_count || 0;
  const dateRange = formatDate(conv.last_message_at || conv.first_message_at);
  const platform = (conv.platform || 'unknown').toLowerCase();
  const isImported = !!conv.is_imported;

  row.innerHTML = `
    <div class="conv-platform ${platformClass(platform, isImported)}">
      ${platformIcon(platform, isImported)}
    </div>
    <div class="conv-info">
      <div class="conv-title" title="${title.replace(/"/g, '&quot;')}">${escapeHtml(title)}</div>
      <div class="conv-meta">
        <span>${platform}</span>
        <span>${turns} turns</span>
        <span>${dateRange}</span>
        ${isImported ? '<span>imported</span>' : ''}
      </div>
    </div>
    <div class="conv-actions">
      <button class="btn-icon ${conv.exclude_from_search ? 'active' : ''}" data-action="toggle-hide" title="${conv.exclude_from_search ? 'Unhide from search' : 'Hide from search'}">
        ${conv.exclude_from_search ? '👁️' : '🙈'}
      </button>
      <button class="btn-icon danger" data-action="delete" title="Delete conversation">
        🗑️
      </button>
    </div>
  `;

  // Event delegation for buttons
  row.querySelector('[data-action="toggle-hide"]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleExclude(conv);
  });

  row.querySelector('[data-action="delete"]').addEventListener('click', (e) => {
    e.stopPropagation();
    showDeleteModal(conv);
  });

  return row;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderAll() {
  conversationList.innerHTML = '';

  if (conversations.length === 0) {
    emptyState.classList.remove('hidden');
    loadMoreContainer.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  for (const conv of conversations) {
    conversationList.appendChild(renderConversation(conv));
  }

  // Show/hide load more
  if (conversations.length < totalConversations) {
    loadMoreContainer.classList.remove('hidden');
  } else {
    loadMoreContainer.classList.add('hidden');
  }

  totalCount.textContent = `${totalConversations} conversation${totalConversations !== 1 ? 's' : ''}`;
}

// ===== Data Loading =====

async function loadConversations(append = false) {
  try {
    if (!append) {
      conversationList.innerHTML = '<div class="loading">Loading conversations...</div>';
    }

    const response = await chrome.runtime.sendMessage({
      type: 'GET_CONVERSATIONS',
      offset: currentOffset,
      limit: PAGE_SIZE,
    });

    if (!response?.success) {
      conversationList.innerHTML = `<div class="loading">Failed to load: ${response?.error || 'Unknown error'}</div>`;
      return;
    }

    if (append) {
      conversations = conversations.concat(response.conversations);
    } else {
      conversations = response.conversations;
    }

    totalConversations = response.total;
    renderAll();
  } catch (error) {
    console.error('Failed to load conversations:', error);
    conversationList.innerHTML = `<div class="loading">Error: ${error.message}</div>`;
  }
}

// ===== Actions =====

async function toggleExclude(conv) {
  const newExclude = !conv.exclude_from_search;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'TOGGLE_EXCLUDE_CONVERSATION',
      conversationId: conv.external_id,
      exclude: newExclude,
    });

    if (response?.success) {
      // Update local state
      conv.exclude_from_search = newExclude;
      renderAll();
    }
  } catch (error) {
    console.error('Toggle exclude failed:', error);
  }
}

function showDeleteModal(conv) {
  pendingDeleteId = conv.external_id;
  deleteModalTitle.textContent = `"${conv.title || 'Untitled conversation'}"`;
  deleteModal.classList.remove('hidden');
}

function hideDeleteModal() {
  pendingDeleteId = null;
  deleteModal.classList.add('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;

  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = 'Deleting...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DELETE_CONVERSATION',
      conversationId: pendingDeleteId,
    });

    if (response?.success) {
      // Remove from local array
      conversations = conversations.filter(c => c.external_id !== pendingDeleteId);
      totalConversations = Math.max(0, totalConversations - 1);
      renderAll();
    }
  } catch (error) {
    console.error('Delete failed:', error);
  } finally {
    hideDeleteModal();
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
  }
}

async function handleDeleteAll() {
  const confirmed = confirm(
    'This will permanently delete ALL your stored conversations, preferences, and entities.\n\n' +
    'This cannot be undone. Are you sure?'
  );
  if (!confirmed) return;

  deleteAllBtn.disabled = true;
  deleteAllBtn.textContent = 'Deleting...';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_ALL_MY_DATA' });
    if (response?.success) {
      conversations = [];
      totalConversations = 0;
      renderAll();
    }
  } catch (error) {
    console.error('Delete all failed:', error);
  } finally {
    deleteAllBtn.disabled = false;
    deleteAllBtn.textContent = 'Delete All';
  }
}

// ===== Event Listeners =====

loadMoreBtn.addEventListener('click', () => {
  currentOffset += PAGE_SIZE;
  loadConversations(true);
});

deleteCancelBtn.addEventListener('click', hideDeleteModal);
deleteConfirmBtn.addEventListener('click', confirmDelete);
deleteAllBtn.addEventListener('click', handleDeleteAll);

// Close modal on backdrop click
document.querySelector('.modal-backdrop')?.addEventListener('click', hideDeleteModal);

// ===== Init =====
loadConversations();

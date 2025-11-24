# Archive - Legacy Implementation Files

This directory contains legacy implementation files that have been superseded by the new `platforms/` architecture.

## Removed Files (2025-11-24)

### Root-level Content Scripts (Legacy Day 3)
The following files were removed as they're no longer referenced in `manifest.json`:

- **content.js** - Original content script for ChatGPT
- **inject.js** - Basic injection script
- **inject-day3.js** - Day 3 injection script with context
- **inject-day3-fixed.js** - Day 3 injection script with CSP fixes

### Current Architecture

The extension now uses a platform-based architecture:

**ChatGPT:**
- `platforms/chatgpt/content.js` - Content script
- `platforms/chatgpt/inject.js` - Page context injection

**Claude:**
- `platforms/claude/content_test.js` - Content script (test mode)
- `platforms/claude/content_bridge.js` - Content script bridge
- `platforms/claude/inject.js` - Page context injection

### Why These Files Were Removed

1. Not referenced in `manifest.json`
2. Replaced by platform-specific implementations
3. Caused confusion about which code is active
4. Git history preserved if restoration needed

### Restoration

If you need to restore any of these files:
```bash
git log --all --full-history -- content.js inject.js inject-day3.js inject-day3-fixed.js
git checkout <commit-hash> -- <filename>
```

## Notes

- All legacy files were fully committed to git history before removal
- No functionality was lost - equivalent implementations exist in `platforms/`
- This cleanup improves codebase clarity and maintainability

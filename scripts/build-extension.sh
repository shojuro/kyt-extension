#!/usr/bin/env bash
#
# Build a clean extension package on Windows-native NTFS.
#
# Chrome's "Load unpacked" from WSL2's 9P filesystem is the primary cause of
# 15-30 minute browser startup delays. This script copies only the ~70 files
# Chrome actually needs (~2 MB) instead of the full 445 MB repo.
#
# Usage:
#   ./scripts/build-extension.sh              # default target
#   ./scripts/build-extension.sh /mnt/d/ext   # custom target
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default target: Windows NTFS for fast native reads
DEFAULT_TARGET="/mnt/c/Users/JM505 Computers/kyt-extension"
TARGET="${1:-$DEFAULT_TARGET}"

echo "=== K.Y.T. Extension Build ==="
echo "Source: $PROJECT_ROOT ($(du -sh "$PROJECT_ROOT" 2>/dev/null | cut -f1))"
echo "Target: $TARGET"
echo ""

# Clean previous build
rm -rf "$TARGET"
mkdir -p "$TARGET"

# --- Manifest + top-level files ---
cp "$PROJECT_ROOT/manifest.json" "$TARGET/"
cp "$PROJECT_ROOT/background.js" "$TARGET/"
cp "$PROJECT_ROOT/kyt-memory-injection-builder.js" "$TARGET/"
cp "$PROJECT_ROOT/icon.svg" "$TARGET/"
cp "$PROJECT_ROOT/setup.html" "$TARGET/"
cp "$PROJECT_ROOT/setup.js" "$TARGET/"

# --- Popup (HTML, JS, CSS, fonts) ---
mkdir -p "$TARGET/popup/fonts"
cp "$PROJECT_ROOT"/popup/*.html "$TARGET/popup/"
cp "$PROJECT_ROOT"/popup/*.js "$TARGET/popup/"
cp "$PROJECT_ROOT"/popup/*.css "$TARGET/popup/"
cp "$PROJECT_ROOT"/popup/fonts/* "$TARGET/popup/fonts/"

# --- Platforms (content scripts, inject scripts, web-accessible resources) ---
for platform in chatgpt claude gemini notebooklm; do
  mkdir -p "$TARGET/platforms/$platform"
  # Copy all .js files in each platform dir (no subdirs needed)
  cp "$PROJECT_ROOT/platforms/$platform/"*.js "$TARGET/platforms/$platform/" 2>/dev/null || true
done

# --- src/ (service worker imports — selective copy) ---
mkdir -p "$TARGET/src"

# Core modules imported by background.js
SRC_FILES=(
  api-client.js
  assistant-quality-detector.js
  auth-config.js
  bm25-search.js
  browser-search.js
  browser-sync.js
  confidence-filter.js
  context-retrieval.js
  conversation-chunker.js
  conversation-poller.js
  cookie-exporter.js
  edge-search.js
  edge-sync.js
  embedding-circuit-breaker.js
  gemini-auth.js
  haiku-tiebreaker.js
  hyde-preprocessor.js
  hyde-search-generator.js
  intent-classifier.js
  memory-mode.js
  message-handlers.js
  nlm-rpc-proxy.js
  notebooklm-sync.js
  profile-manager.js
  project-manager.js
  query-expansion.js
  query-transformer.js
  recent-topic-cache.js
  supabase-config.js
  sync-controller.js
  tier-sync.js
  turn-limiter.js
)

for f in "${SRC_FILES[@]}"; do
  cp "$PROJECT_ROOT/src/$f" "$TARGET/src/$f" 2>/dev/null || true
done

# Subdirectories of src/
mkdir -p "$TARGET/src/auth"
cp "$PROJECT_ROOT/src/auth/auth-service.js" "$TARGET/src/auth/"
cp "$PROJECT_ROOT/src/auth/google-oauth.js" "$TARGET/src/auth/"
cp "$PROJECT_ROOT/src/auth/migration.js" "$TARGET/src/auth/"

mkdir -p "$TARGET/src/background"
cp "$PROJECT_ROOT/src/background/queue-processor.js" "$TARGET/src/background/"

mkdir -p "$TARGET/src/content"
cp "$PROJECT_ROOT/src/content/queue-manager.js" "$TARGET/src/content/"
cp "$PROJECT_ROOT/src/content/upgrade-banner.js" "$TARGET/src/content/"

mkdir -p "$TARGET/src/history-import"
cp "$PROJECT_ROOT/src/history-import/"*.js "$TARGET/src/history-import/"

mkdir -p "$TARGET/src/lib"
cp "$PROJECT_ROOT/src/lib/jszip-wrapper.js" "$TARGET/src/lib/"
cp "$PROJECT_ROOT/src/lib/jszip.js" "$TARGET/src/lib/"

mkdir -p "$TARGET/src/storage"
cp "$PROJECT_ROOT/src/storage/local-queue.js" "$TARGET/src/storage/"

mkdir -p "$TARGET/src/utils"
cp "$PROJECT_ROOT/src/utils/crypto.js" "$TARGET/src/utils/"
cp "$PROJECT_ROOT/src/utils/fetch.js" "$TARGET/src/utils/"
cp "$PROJECT_ROOT/src/utils/normalize-platform.js" "$TARGET/src/utils/"
cp "$PROJECT_ROOT/src/utils/storage-mutex.js" "$TARGET/src/utils/"

# --- Bridge token (auto-provision for RPC proxy) ---
BRIDGE_TOKEN_FILE="$HOME/.kyt/bridge-token"
if [ -f "$BRIDGE_TOKEN_FILE" ]; then
  echo "{\"bridgeToken\":\"$(cat "$BRIDGE_TOKEN_FILE")\"}" > "$TARGET/kyt-build-config.json"
  echo "   Bridge token embedded from $BRIDGE_TOKEN_FILE"
else
  echo "   ⚠️  No bridge token found at $BRIDGE_TOKEN_FILE — RPC proxy will need manual setup"
fi

# --- Summary ---
echo ""
FILE_COUNT=$(find "$TARGET" -type f | wc -l)
TOTAL_SIZE=$(du -sh "$TARGET" | cut -f1)
echo "✅ Built: $FILE_COUNT files, $TOTAL_SIZE"
echo "   (was: 445 MB from WSL2 root)"
echo ""
echo "Next steps:"
echo "  1. Open chrome://extensions"
echo "  2. Remove the WSL2-loaded K.Y.T. extension"
echo "  3. Click 'Load unpacked' → browse to: $(echo "$TARGET" | sed 's|/mnt/c/|C:\\|;s|/|\\|g')"
echo "  4. Restart Chrome — should open in seconds"

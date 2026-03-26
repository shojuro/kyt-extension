#!/bin/bash
# Install the K.Y.T. native messaging host for Chrome/Chromium.
# This enables the extension to write NLM cookies directly to disk
# without needing the bridge server on port 19418.
#
# Usage: bash scripts/install-native-host.sh [extension-id]
#
# If extension-id is not provided, it will look for it in chrome://extensions
# or prompt you to paste it.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
HOST_SCRIPT="$REPO_DIR/mcp/src/native-host/kyt-cookie-host.js"
HOST_NAME="com.kyt.cookie_host"

# Get extension ID
EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
    echo "K.Y.T. Native Messaging Host Installer"
    echo "======================================="
    echo ""
    echo "To find your extension ID:"
    echo "  1. Open chrome://extensions"
    echo "  2. Enable 'Developer mode' (top right)"
    echo "  3. Find K.Y.T. Memory Extension"
    echo "  4. Copy the ID (e.g., abcdefghijklmnopqrstuvwxyz)"
    echo ""
    read -p "Paste extension ID: " EXT_ID
fi

if [ -z "$EXT_ID" ]; then
    echo "Error: Extension ID is required"
    exit 1
fi

# Determine Chrome native messaging host directory
if [ -d "$HOME/.config/google-chrome" ]; then
    NM_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
elif [ -d "$HOME/.config/chromium" ]; then
    NM_DIR="$HOME/.config/chromium/NativeMessagingHosts"
elif [ -d "$HOME/.config/google-chrome-unstable" ]; then
    NM_DIR="$HOME/.config/google-chrome-unstable/NativeMessagingHosts"
else
    echo "Error: Chrome/Chromium config directory not found"
    exit 1
fi

mkdir -p "$NM_DIR"

# Ensure host script is executable
chmod +x "$HOST_SCRIPT"

# Create a wrapper script that handles Node.js ESM module execution
WRAPPER_SCRIPT="$REPO_DIR/mcp/src/native-host/kyt-cookie-host-wrapper.sh"
cat > "$WRAPPER_SCRIPT" << WRAPPER
#!/bin/bash
# Wrapper for Chrome native messaging — executes the ESM host script with Node.js
exec node --experimental-modules "$HOST_SCRIPT" "\$@"
WRAPPER
chmod +x "$WRAPPER_SCRIPT"

# Write native messaging host manifest
MANIFEST_PATH="$NM_DIR/${HOST_NAME}.json"
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "K.Y.T. Cookie Bridge — exports Google auth cookies for NotebookLM API access",
  "path": "$WRAPPER_SCRIPT",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo ""
echo "✅ Native messaging host installed!"
echo "   Manifest: $MANIFEST_PATH"
echo "   Host:     $WRAPPER_SCRIPT"
echo "   Origin:   chrome-extension://$EXT_ID/"
echo ""
echo "Next steps:"
echo "  1. Restart Chrome (close all windows, reopen)"
echo "  2. The extension will auto-export cookies every 20 minutes"
echo "  3. MCP server reads from ~/.kyt/notebooklm-auth.enc"
echo ""
echo "To verify: check chrome://extensions for native messaging errors"

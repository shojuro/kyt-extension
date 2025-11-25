#!/bin/bash
# Setup local git hooks for security checks
# Run once: ./scripts/setup-hooks.sh

set -e

HOOKS_DIR=".git/hooks"

echo "🔧 Setting up local git hooks..."

# Pre-commit hook
cat > "$HOOKS_DIR/pre-commit" << 'EOF'
#!/bin/bash
# Pre-commit hook: Catch security issues before they reach GitHub

echo "🔍 Running pre-commit security checks..."

# Check for secrets in staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|ts|json|env)$' || true)

if [ -n "$STAGED_FILES" ]; then
    # Check for API keys
    if echo "$STAGED_FILES" | xargs grep -lE 'sk-[a-zA-Z0-9]{20,}|sbp_[a-zA-Z0-9]{20,}' 2>/dev/null; then
        echo "❌ BLOCKED: Possible API key detected in staged files!"
        echo "Remove the secret and use environment variables instead."
        exit 1
    fi

    # Check for hardcoded passwords
    if echo "$STAGED_FILES" | xargs grep -lEi 'password\s*[:=]\s*["\047][^"\047]+["\047]' 2>/dev/null; then
        echo "⚠️ WARNING: Possible hardcoded password detected!"
        read -p "Are you sure you want to commit? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
fi

# Check if .env is being committed
if git diff --cached --name-only | grep -qE '^\.env$'; then
    echo "❌ BLOCKED: Cannot commit .env file!"
    echo "Add to .gitignore: echo '.env' >> .gitignore"
    exit 1
fi

echo "✅ Pre-commit checks passed"
EOF

chmod +x "$HOOKS_DIR/pre-commit"

# Pre-push hook
cat > "$HOOKS_DIR/pre-push" << 'EOF'
#!/bin/bash
# Pre-push hook: Run tests before pushing

echo "🧪 Running tests before push..."

# Run unit tests
if ! npm run test 2>/dev/null; then
    echo "❌ Tests failed! Fix before pushing."
    exit 1
fi

echo "✅ All tests passed"
EOF

chmod +x "$HOOKS_DIR/pre-push"

echo "✅ Git hooks installed!"
echo ""
echo "Hooks installed:"
echo "  - pre-commit: Blocks secrets, checks for .env"
echo "  - pre-push: Runs tests before push"
echo ""
echo "To skip hooks (emergency only): git commit --no-verify"

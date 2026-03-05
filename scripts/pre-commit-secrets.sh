#!/bin/bash
# Pre-commit hook: scan staged files for potential secrets
# Install: cp scripts/pre-commit-secrets.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Or: git config core.hooksPath scripts/hooks

set -e

# Only scan staged files (not the whole repo)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

FOUND=0

# Pattern 1: Hardcoded API keys (sk-, hf_, jina_, etc.)
if echo "$STAGED_FILES" | xargs grep -lnE '(sk-[a-zA-Z0-9]{20,}|hf_[a-zA-Z0-9]{20,}|jina_[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|ghu_[a-zA-Z0-9]{20,})' 2>/dev/null | grep -v node_modules | grep -v '.env.example'; then
  echo "ERROR: Possible API key found in staged files"
  FOUND=1
fi

# Pattern 2: Supabase service role key (eyJ... JWT format, 100+ chars)
if echo "$STAGED_FILES" | xargs grep -lnE 'service.?role.*eyJ[a-zA-Z0-9]{100,}' 2>/dev/null | grep -v node_modules; then
  echo "ERROR: Possible Supabase service role key found"
  FOUND=1
fi

# Pattern 3: Sensitive files being committed
if echo "$STAGED_FILES" | grep -E '\.(env|key|pem|p12)$|credentials\.json|service.account' | grep -v '.env.example' | grep -v '.gitignore'; then
  echo "ERROR: Sensitive file type staged for commit"
  FOUND=1
fi

# Pattern 4: Password/secret assignments in code (not in .md or test files)
if echo "$STAGED_FILES" | grep -v '\.md$' | grep -v 'test' | grep -v 'CLAUDE' | xargs grep -lnE "(password|secret|api_key)\s*[:=]\s*['\"][^'\"]{8,}['\"]" 2>/dev/null | grep -v node_modules | grep -v '.env.example'; then
  echo "ERROR: Possible hardcoded secret found"
  FOUND=1
fi

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo "Commit blocked. Review flagged files above."
  echo "If this is a false positive, use: git commit --no-verify"
  exit 1
fi

exit 0

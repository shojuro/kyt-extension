#!/usr/bin/env bash
set -euo pipefail

# Apply branch protection rules to the main branch via GitHub API.
# Requires: gh CLI authenticated with repo admin permissions.
#
# Usage:
#   scripts/setup-branch-protection.sh
#
# What this configures:
#   - Required status checks: Lint, Unit Tests, Secret Detection, Dependency Vulnerabilities
#   - Enforce admins (even repo owner can't bypass)
#   - Block force pushes and branch deletion
#   - Require PRs with dismiss-stale-reviews

REPO="shojuro/kyt-extension"
BRANCH="main"

echo "Applying branch protection to $REPO ($BRANCH)..."

gh api "repos/$REPO/branches/$BRANCH/protection" \
  -X PUT \
  -F required_status_checks='{"strict":true,"contexts":["Lint","Unit Tests","Secret Detection","Dependency Vulnerabilities"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"dismiss_stale_reviews":true,"required_approving_review_count":0}' \
  -F restrictions=null \
  -F allow_force_pushes=false \
  -F allow_deletions=false

echo ""
echo "Verifying protection..."

gh api "repos/$REPO/branches/$BRANCH/protection" --jq '{
  required_checks: .required_status_checks.contexts,
  enforce_admins: .enforce_admins.enabled,
  force_pushes: .allow_force_pushes.enabled,
  deletions: .allow_deletions.enabled
}'

echo ""
echo "Branch protection applied successfully."

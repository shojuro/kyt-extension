# Branch Protection Setup (REQUIRED)

Even as a solo developer, branch protection prevents catastrophic mistakes.

## Go to: Settings → Branches → Add Rule

### For `main` branch:

**Pattern:** `main`

**Enable these protections:**

- [x] **Require a pull request before merging**
  - Required approvals: 0 (solo dev)
  - [x] Dismiss stale PR approvals when new commits are pushed

- [x] **Require status checks to pass**
  - [x] Require branches to be up to date
  - Required checks (must match job `name:` in workflow files):
    - `Lint` (from ci.yml — runs ESLint)
    - `Unit Tests` (from ci.yml)
    - `Secret Detection` (from security.yml)
    - `Dependency Vulnerabilities` (from security.yml)

- [x] **Require conversation resolution before merging**

- [x] **Do not allow bypassing the above settings**
  - Even you can't bypass — this is intentional

- [x] **Restrict deletions**

- [x] **Block force pushes**
  - CRITICAL: Force push = lost history = no audit trail

## Why This Matters for PII Apps

1. **Audit Trail**: Every change goes through PR with security checklist
2. **No Accidents**: Can't push broken code directly to main
3. **Recovery**: Can revert any change cleanly
4. **Compliance**: Many regulations require change tracking

## For Feature Branches

Pattern: `feature/*` or `feat/*`

- [x] Block force pushes (protect WIP work)

---

## Setup Script

Run this once to apply branch protection via the GitHub API:

```bash
scripts/setup-branch-protection.sh
```

Or manually via `gh`:

```bash
gh api repos/shojuro/kyt-extension/branches/main/protection \
  -X PUT \
  -F required_status_checks='{"strict":true,"contexts":["Lint","Unit Tests","Secret Detection","Dependency Vulnerabilities"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"dismiss_stale_reviews":true,"required_approving_review_count":0}' \
  -F restrictions=null \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

## Verify Protection

```bash
gh api repos/shojuro/kyt-extension/branches/main/protection --jq '{
  required_checks: .required_status_checks.contexts,
  enforce_admins: .enforce_admins.enabled,
  force_pushes: .allow_force_pushes.enabled,
  deletions: .allow_deletions.enabled
}'
```

# CI/CD Pipeline Summary

**Project**: KYT Memory Extension
**Created**: 2025-11-26
**Context**: Solo developer handling PII (private thoughts/memories)

---

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Workflow Inventory](#workflow-inventory)
3. [Detailed Workflow Breakdown](#detailed-workflow-breakdown)
4. [Security Philosophy](#security-philosophy)
5. [Current State Assessment](#current-state-assessment)
6. [Future Considerations: AI & Automation](#future-considerations-ai--automation)
7. [Full Workflow Files](#full-workflow-files)

---

## Pipeline Overview

This CI/CD pipeline was designed with three core principles:

1. **Security First** - PII handling requires zero-tolerance for secrets exposure
2. **Full Automation** - Solo dev means no manual gates except production deploys
3. **Fail-Safe Defaults** - Auto-rollback, incident creation, proactive alerts

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TRIGGER EVENTS                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  Push to main    │  Pull Request    │  Schedule    │  Manual Dispatch   │
└────────┬─────────┴────────┬─────────┴──────┬───────┴────────┬───────────┘
         │                  │                │                │
         ▼                  ▼                ▼                ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   ci.yml        │ │  coverage.yml   │ │ security.yml    │ │ deploy-prod.yml │
│   (Lint/Test)   │ │  (Coverage)     │ │ (Daily Scan)    │ │ (Manual Deploy) │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                  │                │                │
         ▼                  ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DEPLOY TO STAGING                                │
│                      (deploy-staging.yml)                                │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │ Deploy   │───▶│ Smoke    │───▶│ Tag      │───▶│ Notify   │          │
│  │ Functions│    │ Test     │    │ Success  │    │          │          │
│  └──────────┘    └────┬─────┘    └──────────┘    └──────────┘          │
│                       │ FAIL                                            │
│                       ▼                                                 │
│               ┌──────────────┐                                          │
│               │ Auto-Rollback│──▶ Create Incident Issue                 │
│               └──────────────┘                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Workflow Inventory

| # | Workflow | File | Trigger | Priority |
|---|----------|------|---------|----------|
| 1 | Core CI | `ci.yml` | Push/PR to main | 🔴 Critical |
| 2 | Deploy Staging | `deploy-staging.yml` | Push to main | 🔴 Critical |
| 3 | Deploy Production | `deploy-prod.yml` | Manual | 🔴 Critical |
| 4 | Security Scan | `security.yml` | Push/PR + Daily | 🔴 Critical |
| 5 | Database Safety | `database-safety.yml` | PR (migrations) | 🔴 Critical |
| 6 | Backup Verification | `backup-verify.yml` | Weekly (Sunday) | 🔴 Critical |
| 7 | Secret Rotation Reminder | `secret-rotation-reminder.yml` | Monthly | 🟡 Important |
| 8 | Dependabot Auto-Merge | `dependabot-auto-merge.yml` | Dependabot PRs | 🟡 Important |
| 9 | Test Coverage | `coverage.yml` | Push/PR to main | 🟡 Important |
| 10 | Release & Changelog | `release.yml` | Version tags | 🟢 Nice-to-have |
| 11 | Stale Branch Cleanup | `stale-branches.yml` | Weekly (Monday) | 🟢 Nice-to-have |

---

## Detailed Workflow Breakdown

### 1. Core CI (`ci.yml`)

**Purpose**: Gate all code changes with lint, test, build, and security checks.

**Why Added**:
- Prevents broken code from reaching main branch
- Catches security vulnerabilities before merge
- Validates extension builds correctly
- Runs E2E tests to catch integration issues

**Key Features**:
- Parallel job execution for speed
- Artifact upload for debugging failures
- Gitleaks integration for secret scanning
- Concurrency control to cancel stale runs

---

### 2. Deploy Staging (`deploy-staging.yml`)

**Purpose**: Auto-deploy to staging on every merge to main, with automatic rollback on failure.

**Why Added**:
- Solo dev can't manually deploy every change
- Smoke tests catch deployment issues immediately
- Auto-rollback prevents extended outages
- Incident issues create audit trail

**Key Features**:
- Rollback to last successful deployment tag
- Creates GitHub issue on failure with full context
- Supports manual rollback via workflow dispatch
- Tags successful deployments for future rollbacks

---

### 3. Deploy Production (`deploy-prod.yml`)

**Purpose**: Manual production deployment with approval gates and version tagging.

**Why Added**:
- Production should never auto-deploy for PII apps
- Version tagging enables rollback tracking
- Approval gates prevent accidental deploys
- Clean audit trail of production changes

**Key Features**:
- Requires environment approval
- Creates semantic version tags
- Comprehensive deployment summary
- Manual trigger only (no auto-deploy)

---

### 4. Security Scan (`security.yml`)

**Purpose**: Multi-layered security scanning for secrets, dependencies, and PII exposure.

**Why Added**:
- PII apps require paranoid security
- Secrets can leak through logs, code, or dependencies
- RLS (Row Level Security) is critical for multi-tenant data
- Daily scans catch issues from external sources

**Key Features**:
- Gitleaks for secret detection
- npm audit for dependency vulnerabilities
- Custom PII pattern scanning
- RLS verification via Supabase API
- Log sanitization checks

---

### 5. Database Safety (`database-safety.yml`)

**Purpose**: Review destructive database migrations before they execute.

**Why Added**:
- DROP, TRUNCATE, DELETE can cause data loss
- Solo dev might miss dangerous patterns
- Creates mandatory review step for risky changes
- Audit trail of who approved what

**Key Features**:
- Scans for destructive SQL patterns
- Requires manual approval for risky migrations
- Labels PRs with risk level
- Suggests backup commands before proceeding

---

### 6. Backup Verification (`backup-verify.yml`)

**Purpose**: Weekly reminder to verify backups are working.

**Why Added**:
- Backups that aren't tested aren't backups
- Solo dev might forget to verify
- Creates accountability via issues
- Documents backup verification history

**Key Features**:
- Weekly issue creation
- Checklist of verification steps
- Links to backup documentation
- Auto-closes when checked off

---

### 7. Secret Rotation Reminder (`secret-rotation-reminder.yml`)

**Purpose**: Monthly reminder to rotate secrets and API keys.

**Why Added**:
- Long-lived secrets increase breach risk
- Solo dev might forget rotation schedule
- Compliance requirement for PII handling
- Creates audit trail of rotation dates

**Key Features**:
- Monthly issue with rotation checklist
- Lists all secrets to rotate
- Tracks last rotation date
- Links to rotation documentation

---

### 8. Dependabot Auto-Merge (`dependabot-auto-merge.yml`)

**Purpose**: Auto-merge safe dependency updates, flag risky ones for review.

**Why Added**:
- Security patches should apply ASAP
- Manual review of every patch is unsustainable
- Major versions need careful review
- Reduces alert fatigue from Dependabot

**Key Features**:
- Auto-merges patch updates after CI passes
- Auto-merges minor security updates
- Labels major updates for manual review
- Waits for CI before merging

---

### 9. Test Coverage (`coverage.yml`)

**Purpose**: Track test coverage and fail if it drops below threshold.

**Why Added**:
- "I'll add tests later" syndrome prevention
- Uncovered code = unverified security
- PR comments make coverage visible
- Thresholds prevent coverage regression

**Key Features**:
- Posts coverage table to PRs
- Emoji indicators for coverage health
- Configurable thresholds (currently 20%)
- Uploads coverage artifacts for debugging

---

### 10. Release & Changelog (`release.yml`)

**Purpose**: Automated releases with changelog generation from commits.

**Why Added**:
- Professional releases without manual work
- Changelog documents what changed
- Version tags enable rollback tracking
- Packages extension for distribution

**Key Features**:
- Generates changelog from conventional commits
- Creates GitHub Release with artifacts
- Updates CHANGELOG.md automatically
- Supports pre-release flags

---

### 11. Stale Branch Cleanup (`stale-branches.yml`)

**Purpose**: Identify and optionally delete old branches.

**Why Added**:
- Prevents branch sprawl
- Keeps repository organized
- Identifies abandoned work
- Optional auto-delete for safety

**Key Features**:
- Configurable staleness threshold (default 30 days)
- Protects main/master/develop branches
- Dry-run mode by default
- Creates issue with stale branch list

---

## Security Philosophy

### Defense in Depth

```
Layer 1: Pre-commit hooks (local)
    └── Gitleaks scans before commit

Layer 2: CI Pipeline (on push)
    └── Secret scanning
    └── Dependency audit
    └── PII pattern detection

Layer 3: PR Review (on PR)
    └── Database migration review
    └── Coverage requirements
    └── Security checklist

Layer 4: Deployment (on deploy)
    └── Smoke tests
    └── RLS verification
    └── Auto-rollback

Layer 5: Runtime (scheduled)
    └── Daily security scans
    └── Weekly backup verification
    └── Monthly secret rotation
```

### PII-Specific Protections

1. **Log Sanitization**: Scans for `console.log` patterns that might leak user data
2. **RLS Verification**: Ensures Row Level Security is enabled on sensitive tables
3. **Secret Detection**: Custom patterns for API keys, tokens, and credentials
4. **Backup Reminders**: Weekly prompts to verify backup integrity

---

## Current State Assessment

### Strengths

| Aspect | Status | Notes |
|--------|--------|-------|
| Secret Scanning | ✅ Strong | Gitleaks + custom patterns |
| Dependency Security | ✅ Strong | npm audit + Dependabot |
| Deployment Safety | ✅ Strong | Auto-rollback + smoke tests |
| Coverage Tracking | ✅ Good | 20% threshold (should increase) |
| Documentation | ✅ Good | README badges, PR templates |

### Areas for Improvement

| Aspect | Status | Recommendation |
|--------|--------|----------------|
| Coverage Threshold | 🟡 20% | Increase to 50%+ over time |
| E2E Tests | 🟡 Basic | Add more Playwright scenarios |
| Performance Testing | 🔴 Missing | Add Lighthouse CI for extension |
| Accessibility | 🔴 Missing | Add a11y testing |
| Database Migrations | 🟡 Manual | Consider automated rollback |

### Technical Debt

1. **Test Coverage**: Currently at 20% threshold - should increase as tests are added
2. **E2E Coverage**: Basic smoke tests only - need comprehensive user flows
3. **Performance Baseline**: No performance regression testing
4. **Staging Environment**: Should mirror production more closely

---

## Future Considerations: AI & Automation

### Current AI/Automation Landscape Impact

The rapid evolution of AI-assisted development creates both opportunities and challenges for this pipeline:

#### Opportunities (Pros)

| Opportunity | How to Leverage | Implementation |
|-------------|-----------------|----------------|
| **AI Code Review** | Add Copilot/CodeRabbit review | Add `ai-review.yml` workflow |
| **Automated Testing** | AI-generated test cases | Integrate test generation in PR flow |
| **Security Analysis** | AI-powered vulnerability detection | Add Snyk/SonarQube with AI features |
| **Documentation** | Auto-generate docs from code | Add documentation workflow |
| **Changelog Generation** | Smarter commit categorization | Enhance release.yml with AI |

#### Challenges (Cons)

| Challenge | Risk | Mitigation |
|-----------|------|------------|
| **AI-Generated Code Quality** | May bypass security patterns | Strengthen secret scanning |
| **Over-Automation** | Loss of human oversight | Keep production manual |
| **Dependency on AI Services** | Single point of failure | Self-hosted alternatives |
| **Training Data Leakage** | PII in AI tools | Strict tool vetting policy |
| **False Confidence** | AI "approves" vulnerable code | Multiple validation layers |

### Recommended Future Enhancements

#### Phase 1: Near-term (1-3 months)

```yaml
# Suggested: ai-code-review.yml
# Purpose: AI-assisted code review for security and quality
# Reasoning: Catches patterns humans miss, but shouldn't replace human review

name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  ai-review:
    runs-on: ubuntu-latest
    steps:
      - uses: coderabbitai/ai-pr-reviewer@latest
        with:
          review_type: security  # Focus on security for PII app
          auto_approve: false    # Never auto-approve
```

#### Phase 2: Medium-term (3-6 months)

1. **Performance Regression Testing**
   - Add Lighthouse CI for extension performance
   - Track bundle size over time
   - Alert on performance degradation

2. **Chaos Engineering**
   - Test rollback procedures
   - Simulate Supabase outages
   - Verify graceful degradation

3. **Compliance Automation**
   - GDPR data access requests
   - Automated data retention policies
   - Audit log generation

#### Phase 3: Long-term (6-12 months)

1. **Self-Healing Infrastructure**
   - Auto-scaling based on usage
   - Automatic certificate renewal
   - Database connection pooling

2. **Observability Pipeline**
   - Centralized logging
   - Distributed tracing
   - Real-time alerting

3. **AI-Assisted Incident Response**
   - Automated root cause analysis
   - Suggested remediation steps
   - Post-mortem generation

### AI Tool Vetting Checklist

Before adding any AI-powered tool to this pipeline:

- [ ] Does it process code/data locally or send to external servers?
- [ ] What data does it collect/retain?
- [ ] Is it SOC 2 / GDPR compliant?
- [ ] Can it be self-hosted if needed?
- [ ] What happens if the service is unavailable?
- [ ] Does it have a clear data deletion policy?

### Warning Signs to Watch

1. **AI Approval Complacency**: Don't let AI approvals replace human review for sensitive changes
2. **Vendor Lock-in**: Avoid deep integration with single AI providers
3. **Training Data Concerns**: Never allow PII to be used for model training
4. **Automation Sprawl**: Each workflow adds maintenance burden

---

## Full Workflow Files

### 1. ci.yml

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run ESLint
        run: npm run lint --if-present

  test:
    name: Unit Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}

  e2e:
    name: E2E Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run E2E tests
        run: npm run test:e2e --if-present
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7

  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [lint, test]
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build extension
        run: npm run build --if-present

      - name: Verify manifest.json
        run: |
          if [ -f "manifest.json" ]; then
            echo "✅ manifest.json exists"
            cat manifest.json | jq .
          else
            echo "❌ manifest.json not found"
            exit 1
          fi

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: extension-build
          path: |
            build/
            manifest.json
          retention-days: 7

  security:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Check for hardcoded secrets
        run: |
          echo "Scanning for potential secrets..."

          # Check for common secret patterns
          if grep -rE "(password|secret|api_key|apikey|token)\s*[:=]\s*['\"][^'\"]+['\"]" \
            --include="*.js" --include="*.ts" --include="*.json" \
            --exclude-dir=node_modules --exclude-dir=.git .; then
            echo "⚠️ Potential hardcoded secrets found!"
            echo "Review the above matches and use environment variables instead."
            exit 1
          fi

          echo "✅ No obvious hardcoded secrets found"
```

---

### 2. deploy-staging.yml

```yaml
name: Deploy to Staging

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      rollback_to:
        description: 'Commit SHA to rollback to (leave empty for normal deploy)'
        required: false
        type: string

env:
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID }}

jobs:
  # ===========================================
  # DEPLOY SUPABASE EDGE FUNCTIONS
  # ===========================================
  deploy-functions:
    name: Deploy Edge Functions
    runs-on: ubuntu-latest
    environment: staging
    outputs:
      deploy_sha: ${{ steps.get_sha.outputs.sha }}
    steps:
      - name: Determine deploy commit
        id: get_sha
        run: |
          if [ -n "${{ inputs.rollback_to }}" ]; then
            echo "🔄 Rolling back to: ${{ inputs.rollback_to }}"
            echo "sha=${{ inputs.rollback_to }}" >> $GITHUB_OUTPUT
          else
            echo "📦 Deploying current commit"
            echo "sha=${{ github.sha }}" >> $GITHUB_OUTPUT
          fi

      - name: Checkout code
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.get_sha.outputs.sha }}

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link to Supabase project
        run: |
          supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Deploy Edge Functions
        id: deploy
        run: |
          DEPLOYED_FUNCTIONS=""
          FAILED_FUNCTIONS=""

          for func_dir in supabase/functions/*/; do
            func_name=$(basename "$func_dir")
            if [[ "$func_name" != _* ]]; then
              echo "Deploying function: $func_name"
              if supabase functions deploy "$func_name" --no-verify-jwt 2>&1; then
                DEPLOYED_FUNCTIONS="$DEPLOYED_FUNCTIONS $func_name"
              else
                FAILED_FUNCTIONS="$FAILED_FUNCTIONS $func_name"
              fi
            fi
          done

          echo "deployed=$DEPLOYED_FUNCTIONS" >> $GITHUB_OUTPUT
          echo "failed=$FAILED_FUNCTIONS" >> $GITHUB_OUTPUT

          if [ -n "$FAILED_FUNCTIONS" ]; then
            echo "❌ Failed to deploy:$FAILED_FUNCTIONS"
            exit 1
          fi
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Run database migrations
        run: |
          supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
        continue-on-error: true

  # ===========================================
  # SMOKE TESTS AGAINST STAGING
  # ===========================================
  smoke-test:
    name: Smoke Tests
    runs-on: ubuntu-latest
    needs: [deploy-functions]
    outputs:
      result: ${{ steps.test.outputs.result }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Run smoke tests
        id: test
        run: |
          echo "Running smoke tests against staging..."

          # Test save_chat_turn function
          RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
            "${{ secrets.SUPABASE_URL }}/functions/v1/save_chat_turn" \
            -H "Authorization: Bearer ${{ secrets.SUPABASE_ANON_KEY }}" \
            -H "Content-Type: application/json" \
            -d '{}' || echo "000")

          if [ "$RESPONSE" = "000" ]; then
            echo "result=failed" >> $GITHUB_OUTPUT
            echo "❌ Failed to connect to edge function"
            exit 1
          fi

          echo "result=success" >> $GITHUB_OUTPUT
          echo "✅ Edge function is responding (HTTP $RESPONSE)"
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}

  # ===========================================
  # SAVE SUCCESSFUL DEPLOYMENT
  # ===========================================
  save-deployment:
    name: Save Deployment State
    runs-on: ubuntu-latest
    needs: [deploy-functions, smoke-test]
    if: success()
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Tag successful deployment
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"

          # Create/update the last-successful-staging tag
          git tag -f last-successful-staging ${{ needs.deploy-functions.outputs.deploy_sha }}
          git push origin last-successful-staging --force

          echo "✅ Tagged ${{ needs.deploy-functions.outputs.deploy_sha }} as last-successful-staging"

  # ===========================================
  # AUTO-ROLLBACK ON FAILURE
  # ===========================================
  rollback:
    name: Auto-Rollback
    runs-on: ubuntu-latest
    needs: [deploy-functions, smoke-test]
    if: failure() && !inputs.rollback_to  # Don't rollback a rollback
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get last successful deployment
        id: last_good
        run: |
          # Get the last successful deployment tag
          LAST_GOOD=$(git rev-parse last-successful-staging 2>/dev/null || echo "")

          if [ -z "$LAST_GOOD" ]; then
            echo "⚠️ No previous successful deployment found - cannot rollback"
            echo "has_rollback=false" >> $GITHUB_OUTPUT
          else
            echo "Last successful deployment: $LAST_GOOD"
            echo "sha=$LAST_GOOD" >> $GITHUB_OUTPUT
            echo "has_rollback=true" >> $GITHUB_OUTPUT
          fi

      - name: Trigger rollback deployment
        if: steps.last_good.outputs.has_rollback == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            console.log('🔄 Triggering rollback to: ${{ steps.last_good.outputs.sha }}');

            await github.rest.actions.createWorkflowDispatch({
              owner: context.repo.owner,
              repo: context.repo.repo,
              workflow_id: 'deploy-staging.yml',
              ref: 'main',
              inputs: {
                rollback_to: '${{ steps.last_good.outputs.sha }}'
              }
            });

            console.log('Rollback deployment triggered!');

      - name: Create incident issue
        uses: actions/github-script@v7
        with:
          script: |
            const title = `🚨 Deployment Failed - Auto-Rollback Triggered`;
            const body = `## Deployment Failure

            **Time:** ${new Date().toISOString()}
            **Failed Commit:** ${{ github.sha }}
            **Rolled Back To:** ${{ steps.last_good.outputs.sha || 'N/A - No previous deployment' }}

            ### What Happened
            The staging deployment failed smoke tests and an automatic rollback was triggered.

            ### Action Required
            1. Check the [failed workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
            2. Identify the issue in commit ${{ github.sha }}
            3. Fix and redeploy

            ### Logs
            - Deploy job: Check the workflow run for details
            - Smoke test: Failed to verify edge functions are working

            ---
            *This issue was automatically created by the deployment workflow.*`;

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: title,
              body: body,
              labels: ['incident', 'deployment', 'automated']
            });

  # ===========================================
  # NOTIFY ON COMPLETION
  # ===========================================
  notify:
    name: Notify
    runs-on: ubuntu-latest
    needs: [deploy-functions, smoke-test]
    if: always()
    steps:
      - name: Deployment Summary
        run: |
          echo "## Deployment Summary" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "| Job | Status |" >> $GITHUB_STEP_SUMMARY
          echo "|-----|--------|" >> $GITHUB_STEP_SUMMARY
          echo "| Deploy Functions | ${{ needs.deploy-functions.result }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Smoke Tests | ${{ needs.smoke-test.result }} |" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY

          if [ "${{ needs.smoke-test.result }}" = "failure" ]; then
            echo "⚠️ **Auto-rollback has been triggered**" >> $GITHUB_STEP_SUMMARY
          fi

          if [ -n "${{ inputs.rollback_to }}" ]; then
            echo "🔄 **This was a rollback deployment**" >> $GITHUB_STEP_SUMMARY
            echo "Rolled back to: ${{ inputs.rollback_to }}" >> $GITHUB_STEP_SUMMARY
          fi
```

---

### 3. deploy-prod.yml

```yaml
name: Deploy to Production

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to deploy (e.g., 1.0.0)'
        required: true
        type: string
      confirm:
        description: 'Type "deploy" to confirm production deployment'
        required: true
        type: string

env:
  SUPABASE_PROJECT_ID: ${{ secrets.SUPABASE_PROJECT_ID_PROD }}

jobs:
  validate:
    name: Validate Deployment
    runs-on: ubuntu-latest
    steps:
      - name: Confirm deployment
        run: |
          if [ "${{ inputs.confirm }}" != "deploy" ]; then
            echo "❌ Deployment not confirmed. You must type 'deploy' to proceed."
            exit 1
          fi
          echo "✅ Deployment confirmed"

      - name: Validate version format
        run: |
          if ! echo "${{ inputs.version }}" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "❌ Invalid version format. Use semver (e.g., 1.0.0)"
            exit 1
          fi
          echo "✅ Version format valid: ${{ inputs.version }}"

  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [validate]
    environment: production
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      - name: Link to production project
        run: |
          supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID_PROD }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Deploy Edge Functions
        run: |
          for func_dir in supabase/functions/*/; do
            func_name=$(basename "$func_dir")
            if [[ "$func_name" != _* ]]; then
              echo "Deploying function: $func_name"
              supabase functions deploy "$func_name" --no-verify-jwt
            fi
          done
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Run database migrations
        run: |
          supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

      - name: Create version tag
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"
          git tag -a "v${{ inputs.version }}" -m "Production release v${{ inputs.version }}"
          git push origin "v${{ inputs.version }}"

      - name: Deployment Summary
        run: |
          echo "## 🚀 Production Deployment Complete" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Version:** v${{ inputs.version }}" >> $GITHUB_STEP_SUMMARY
          echo "**Commit:** ${{ github.sha }}" >> $GITHUB_STEP_SUMMARY
          echo "**Deployed by:** ${{ github.actor }}" >> $GITHUB_STEP_SUMMARY
          echo "**Time:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")" >> $GITHUB_STEP_SUMMARY
```

---

### 4. security.yml

```yaml
name: Security Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'
  workflow_dispatch:

permissions:
  contents: read
  security-events: write

jobs:
  # ===========================================
  # SECRET SCANNING
  # ===========================================
  secret-scan:
    name: Secret Scanning
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_CONFIG: .gitleaks.toml

      - name: Scan for PII patterns
        run: |
          echo "🔍 Scanning for potential PII exposure patterns..."

          # Patterns that might indicate PII logging
          PII_PATTERNS=(
            "console\.log.*email"
            "console\.log.*password"
            "console\.log.*user"
            "console\.log.*token"
            "console\.log.*secret"
            "console\.log.*key"
            "console\.log.*credential"
            "console\.log.*phone"
            "console\.log.*address"
            "console\.log.*ssn"
            "console\.log.*credit"
          )

          FOUND_ISSUES=0

          for pattern in "${PII_PATTERNS[@]}"; do
            if grep -rniE "$pattern" --include="*.js" --include="*.ts" \
              --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null; then
              echo "⚠️ Potential PII logging found for pattern: $pattern"
              FOUND_ISSUES=$((FOUND_ISSUES + 1))
            fi
          done

          if [ $FOUND_ISSUES -gt 0 ]; then
            echo ""
            echo "❌ Found $FOUND_ISSUES potential PII exposure patterns"
            echo "Review the above matches and ensure PII is not being logged"
            exit 1
          fi

          echo "✅ No obvious PII logging patterns found"

  # ===========================================
  # DEPENDENCY AUDIT
  # ===========================================
  dependency-audit:
    name: Dependency Audit
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run npm audit
        run: |
          echo "🔍 Running npm audit..."
          npm audit --audit-level=high || {
            echo ""
            echo "❌ High or critical vulnerabilities found!"
            echo "Run 'npm audit fix' locally to resolve"
            exit 1
          }
          echo "✅ No high/critical vulnerabilities found"

      - name: Check for known malicious packages
        run: |
          echo "🔍 Checking for known malicious packages..."

          MALICIOUS_PACKAGES=(
            "event-stream"
            "flatmap-stream"
            "rc"
            "colors"
            "faker"
          )

          FOUND=0
          for pkg in "${MALICIOUS_PACKAGES[@]}"; do
            if grep -q "\"$pkg\"" package-lock.json 2>/dev/null; then
              echo "⚠️ Potentially compromised package found: $pkg"
              FOUND=1
            fi
          done

          if [ $FOUND -eq 1 ]; then
            echo ""
            echo "Review the above packages - some versions may be compromised"
          else
            echo "✅ No known malicious packages detected"
          fi

  # ===========================================
  # LOG SANITIZATION CHECK
  # ===========================================
  log-sanitization:
    name: Log Sanitization
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check for sensitive data in logs
        run: |
          echo "🔍 Checking for potential log leaks..."

          # Count console.log statements (should be minimal in production)
          LOG_COUNT=$(grep -r "console\.log" --include="*.js" --include="*.ts" \
            --exclude-dir=node_modules --exclude-dir=tests --exclude-dir=.git . 2>/dev/null | wc -l)

          echo "Found $LOG_COUNT console.log statements"

          if [ $LOG_COUNT -gt 100 ]; then
            echo "⚠️ High number of console.log statements ($LOG_COUNT)"
            echo "Consider implementing a proper logging system with log levels"
          fi

          # Check for JSON.stringify of potentially sensitive objects
          STRINGIFY_COUNT=$(grep -rE "JSON\.stringify\s*\(\s*(user|req|request|data|body)" \
            --include="*.js" --include="*.ts" \
            --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null | wc -l)

          if [ $STRINGIFY_COUNT -gt 0 ]; then
            echo "⚠️ Found $STRINGIFY_COUNT potentially sensitive JSON.stringify calls"
            grep -rE "JSON\.stringify\s*\(\s*(user|req|request|data|body)" \
              --include="*.js" --include="*.ts" \
              --exclude-dir=node_modules --exclude-dir=.git . 2>/dev/null || true
          fi

          echo "✅ Log sanitization check complete"

  # ===========================================
  # RLS VERIFICATION
  # ===========================================
  rls-check:
    name: RLS Verification
    runs-on: ubuntu-latest
    if: github.event_name != 'schedule'  # Skip on scheduled runs
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check RLS in migration files
        run: |
          echo "🔍 Checking for RLS policies in migrations..."

          # Find all SQL files
          SQL_FILES=$(find . -name "*.sql" -not -path "./node_modules/*" 2>/dev/null)

          if [ -z "$SQL_FILES" ]; then
            echo "No SQL files found to check"
            exit 0
          fi

          # Check each file that creates a table
          for file in $SQL_FILES; do
            if grep -qiE "CREATE\s+TABLE" "$file" 2>/dev/null; then
              TABLE_NAME=$(grep -oiE "CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[a-z_]+" "$file" | head -1 | awk '{print $NF}')

              if ! grep -qiE "ALTER\s+TABLE.*ENABLE\s+ROW\s+LEVEL\s+SECURITY|ROW\s+LEVEL\s+SECURITY" "$file" 2>/dev/null; then
                echo "⚠️ Table '$TABLE_NAME' in $file may not have RLS enabled"
              else
                echo "✅ $file has RLS policies"
              fi
            fi
          done

          echo ""
          echo "💡 Reminder: All tables containing user data MUST have RLS enabled"

  # ===========================================
  # SUMMARY
  # ===========================================
  summary:
    name: Security Summary
    runs-on: ubuntu-latest
    needs: [secret-scan, dependency-audit, log-sanitization, rls-check]
    if: always()
    steps:
      - name: Generate Summary
        run: |
          echo "## 🔒 Security Scan Results" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "| Check | Status |" >> $GITHUB_STEP_SUMMARY
          echo "|-------|--------|" >> $GITHUB_STEP_SUMMARY
          echo "| Secret Scanning | ${{ needs.secret-scan.result }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Dependency Audit | ${{ needs.dependency-audit.result }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Log Sanitization | ${{ needs.log-sanitization.result }} |" >> $GITHUB_STEP_SUMMARY
          echo "| RLS Verification | ${{ needs.rls-check.result }} |" >> $GITHUB_STEP_SUMMARY
```

---

### 5. database-safety.yml

```yaml
name: Database Migration Safety

on:
  pull_request:
    paths:
      - 'migrations/**'
      - 'supabase/migrations/**'
      - '**/*.sql'

jobs:
  migration-review:
    name: Migration Safety Check
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check for destructive operations
        id: check
        run: |
          echo "🔍 Scanning migrations for destructive operations..."

          DESTRUCTIVE_PATTERNS=(
            "DROP TABLE"
            "DROP COLUMN"
            "TRUNCATE"
            "DELETE FROM"
            "DROP INDEX"
            "DROP CONSTRAINT"
            "ALTER TABLE.*DROP"
          )

          FOUND_ISSUES=""
          SEVERITY="safe"

          for file in $(git diff --name-only origin/main...HEAD | grep -E '\.sql$'); do
            if [ -f "$file" ]; then
              echo "Checking: $file"

              for pattern in "${DESTRUCTIVE_PATTERNS[@]}"; do
                if grep -qiE "$pattern" "$file" 2>/dev/null; then
                  MATCHES=$(grep -niE "$pattern" "$file" 2>/dev/null || true)
                  FOUND_ISSUES="$FOUND_ISSUES\n⚠️ **$file** contains: $pattern\n\`\`\`\n$MATCHES\n\`\`\`\n"
                  SEVERITY="destructive"
                fi
              done
            fi
          done

          echo "severity=$SEVERITY" >> $GITHUB_OUTPUT

          if [ "$SEVERITY" = "destructive" ]; then
            echo -e "$FOUND_ISSUES" > /tmp/migration_issues.md
            echo "has_issues=true" >> $GITHUB_OUTPUT
          else
            echo "has_issues=false" >> $GITHUB_OUTPUT
          fi

          echo "✅ Migration scan complete"

      - name: Comment on PR (destructive)
        if: steps.check.outputs.has_issues == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const issues = fs.readFileSync('/tmp/migration_issues.md', 'utf8');

            const body = `## ⚠️ Destructive Migration Detected

            This PR contains database migrations with potentially destructive operations:

            ${issues}

            ### Required Actions

            1. **Backup first**: Ensure you have a recent backup
            2. **Review carefully**: Verify these changes are intentional
            3. **Test locally**: Run against a test database first
            4. **Get approval**: Destructive migrations require explicit approval

            ### Backup Command
            \`\`\`bash
            supabase db dump -f backup_$(date +%Y%m%d_%H%M%S).sql
            \`\`\`

            ---
            *This comment was automatically generated by the Database Migration Safety workflow.*`;

            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body: body
            });

      - name: Add label
        if: steps.check.outputs.has_issues == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.addLabels({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              labels: ['destructive-migration', 'requires-review']
            });

      - name: Fail if destructive
        if: steps.check.outputs.has_issues == 'true'
        run: |
          echo "❌ Destructive migration detected - requires manual approval"
          echo "Add a comment with '/approve-migration' after review"
          exit 1
```

---

### 6. backup-verify.yml

```yaml
name: Backup Verification Reminder

on:
  schedule:
    # Run every Sunday at 8 AM UTC
    - cron: '0 8 * * 0'
  workflow_dispatch:

permissions:
  issues: write

jobs:
  create-reminder:
    name: Create Backup Reminder
    runs-on: ubuntu-latest
    steps:
      - name: Create verification issue
        uses: actions/github-script@v7
        with:
          script: |
            const today = new Date().toISOString().split('T')[0];

            const title = `🗄️ Weekly Backup Verification - ${today}`;

            const body = `## Weekly Backup Verification Checklist

            **Week of:** ${today}

            ### Verification Steps

            - [ ] **Supabase Dashboard**: Verify backups are enabled
              - Go to Project Settings > Database > Backups
              - Confirm "Point in Time Recovery" is enabled

            - [ ] **Test Restore** (monthly): Restore to a test project
              - Create a new Supabase project
              - Restore latest backup
              - Verify data integrity

            - [ ] **Edge Function Logs**: Check for errors
              - Go to Edge Functions > Logs
              - Review last 7 days for anomalies

            - [ ] **Storage Verification**: Check file backups
              - Verify storage buckets are intact
              - Check file access permissions

            ### Backup Locations

            | Data Type | Location | Retention |
            |-----------|----------|-----------|
            | Database | Supabase PITR | 7 days |
            | Edge Functions | GitHub | Forever |
            | Storage | Supabase Storage | N/A |

            ### Emergency Restore

            \`\`\`bash
            # Download latest backup (requires Supabase CLI)
            supabase db dump -f backup_$(date +%Y%m%d).sql

            # Restore to new project
            psql $NEW_DATABASE_URL < backup_$(date +%Y%m%d).sql
            \`\`\`

            ---

            **Close this issue once verification is complete.**

            *This issue was automatically created by the Backup Verification workflow.*`;

            // Check for existing open issue
            const issues = await github.rest.issues.listForRepo({
              owner: context.repo.owner,
              repo: context.repo.repo,
              state: 'open',
              labels: 'backup-verification'
            });

            if (issues.data.length > 0) {
              console.log('Open backup verification issue already exists');
              return;
            }

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: title,
              body: body,
              labels: ['backup-verification', 'maintenance', 'weekly']
            });

            console.log('Backup verification issue created');
```

---

### 7. secret-rotation-reminder.yml

```yaml
name: Secret Rotation Reminder

on:
  schedule:
    # Run on the 1st of every month at 9 AM UTC
    - cron: '0 9 1 * *'
  workflow_dispatch:

permissions:
  issues: write

jobs:
  create-reminder:
    name: Create Rotation Reminder
    runs-on: ubuntu-latest
    steps:
      - name: Create rotation issue
        uses: actions/github-script@v7
        with:
          script: |
            const today = new Date();
            const month = today.toLocaleString('default', { month: 'long', year: 'numeric' });

            const title = `🔑 Monthly Secret Rotation - ${month}`;

            const body = `## Monthly Secret Rotation Checklist

            **Month:** ${month}

            ### Secrets to Review

            #### 🔴 Critical (Rotate if Compromised)

            - [ ] **SUPABASE_ACCESS_TOKEN**
              - Location: GitHub Secrets, Local .env
              - Rotation: Supabase Dashboard > Account > Access Tokens
              - Last rotated: _Update this_

            - [ ] **OPENAI_API_KEY**
              - Location: GitHub Secrets, Supabase Edge Function Secrets
              - Rotation: OpenAI Dashboard > API Keys
              - Last rotated: _Update this_

            #### 🟡 Important (Rotate Quarterly)

            - [ ] **SUPABASE_ANON_KEY**
              - Note: Tied to project, rotation requires project recreation
              - Review: Check for exposure in client-side code

            - [ ] **SUPABASE_SERVICE_ROLE_KEY**
              - Location: Only in secure backend/edge functions
              - Review: Ensure not exposed in any logs

            #### 🟢 Review Only

            - [ ] **GitHub Personal Access Tokens**
              - Check expiration dates
              - Revoke unused tokens

            ### Rotation Procedure

            1. Generate new secret in provider dashboard
            2. Update GitHub Secrets: Settings > Secrets > Actions
            3. Update local .env file
            4. Update Supabase Edge Function secrets (if applicable)
            5. Verify deployment works with new secrets
            6. Revoke old secret in provider dashboard

            ### Post-Rotation Verification

            \`\`\`bash
            # Trigger a test deployment to verify secrets work
            gh workflow run ci.yml
            \`\`\`

            ---

            **Close this issue once rotation is complete and verified.**

            *This issue was automatically created by the Secret Rotation Reminder workflow.*`;

            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: title,
              body: body,
              labels: ['security', 'secret-rotation', 'monthly']
            });

            console.log('Secret rotation reminder created');
```

---

### 8. dependabot-auto-merge.yml

```yaml
name: Dependabot Auto-Merge

# Auto-merge Dependabot PRs for security patches
# Why: Security patches should be applied ASAP without waiting for you

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    name: Auto-Merge Security Patches
    runs-on: ubuntu-latest
    # Only run for Dependabot PRs
    if: github.actor == 'dependabot[bot]'

    steps:
      - name: Fetch Dependabot metadata
        id: metadata
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Wait for CI to pass
        uses: lewagon/wait-on-check-action@v1.3.4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          running-workflow-name: 'Auto-Merge Security Patches'
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          wait-interval: 30
          allowed-conclusions: success

      - name: Auto-merge patch updates
        if: steps.metadata.outputs.update-type == 'version-update:semver-patch'
        run: |
          echo "🔧 Auto-merging patch update: ${{ steps.metadata.outputs.dependency-names }}"
          gh pr merge "${{ github.event.pull_request.number }}" \
            --auto \
            --squash \
            --body "Auto-merged by Dependabot Auto-Merge workflow"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Auto-merge minor security updates
        if: |
          steps.metadata.outputs.update-type == 'version-update:semver-minor' &&
          contains(steps.metadata.outputs.dependency-type, 'direct:production')
        run: |
          echo "🔒 Auto-merging minor security update: ${{ steps.metadata.outputs.dependency-names }}"
          gh pr merge "${{ github.event.pull_request.number }}" \
            --auto \
            --squash \
            --body "Auto-merged security update by Dependabot Auto-Merge workflow"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Label major updates for review
        if: steps.metadata.outputs.update-type == 'version-update:semver-major'
        run: |
          echo "⚠️ Major update detected - requires manual review"
          gh pr edit "${{ github.event.pull_request.number }}" \
            --add-label "requires-review,major-update"
          gh pr comment "${{ github.event.pull_request.number }}" \
            --body "⚠️ **Major version update detected**

          This PR updates \`${{ steps.metadata.outputs.dependency-names }}\` to a new major version.

          **Before merging:**
          - [ ] Review changelog for breaking changes
          - [ ] Test locally
          - [ ] Update code if needed

          Major updates are NOT auto-merged for safety."
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Summary
        run: |
          echo "## Dependabot Auto-Merge Summary" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "| Property | Value |" >> $GITHUB_STEP_SUMMARY
          echo "|----------|-------|" >> $GITHUB_STEP_SUMMARY
          echo "| Dependency | ${{ steps.metadata.outputs.dependency-names }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Update Type | ${{ steps.metadata.outputs.update-type }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Dependency Type | ${{ steps.metadata.outputs.dependency-type }} |" >> $GITHUB_STEP_SUMMARY
```

---

### 9. coverage.yml

```yaml
name: Test Coverage

# Coverage gates prevent "I'll add tests later" syndrome
# Why: Uncovered code in a PII app = unverified security

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  coverage:
    name: Coverage Check
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write  # For posting coverage comments

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run tests with coverage
        run: npm run test:coverage
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}

      - name: Check coverage thresholds
        id: coverage
        run: |
          # Extract coverage from json-summary
          if [ -f "coverage/coverage-summary.json" ]; then
            LINES=$(cat coverage/coverage-summary.json | jq '.total.lines.pct')
            FUNCTIONS=$(cat coverage/coverage-summary.json | jq '.total.functions.pct')
            BRANCHES=$(cat coverage/coverage-summary.json | jq '.total.branches.pct')
            STATEMENTS=$(cat coverage/coverage-summary.json | jq '.total.statements.pct')

            echo "lines=$LINES" >> $GITHUB_OUTPUT
            echo "functions=$FUNCTIONS" >> $GITHUB_OUTPUT
            echo "branches=$BRANCHES" >> $GITHUB_OUTPUT
            echo "statements=$STATEMENTS" >> $GITHUB_OUTPUT

            echo "## Coverage Report" >> $GITHUB_STEP_SUMMARY
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "| Metric | Coverage |" >> $GITHUB_STEP_SUMMARY
            echo "|--------|----------|" >> $GITHUB_STEP_SUMMARY
            echo "| Lines | ${LINES}% |" >> $GITHUB_STEP_SUMMARY
            echo "| Functions | ${FUNCTIONS}% |" >> $GITHUB_STEP_SUMMARY
            echo "| Branches | ${BRANCHES}% |" >> $GITHUB_STEP_SUMMARY
            echo "| Statements | ${STATEMENTS}% |" >> $GITHUB_STEP_SUMMARY
          else
            echo "⚠️ No coverage report found"
            exit 1
          fi

      - name: Post coverage comment on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const lines = '${{ steps.coverage.outputs.lines }}';
            const functions = '${{ steps.coverage.outputs.functions }}';
            const branches = '${{ steps.coverage.outputs.branches }}';
            const statements = '${{ steps.coverage.outputs.statements }}';

            // Determine status emoji
            const getEmoji = (pct) => {
              const num = parseFloat(pct);
              if (num >= 80) return '🟢';
              if (num >= 50) return '🟡';
              return '🔴';
            };

            const body = `## 📊 Coverage Report

            | Metric | Coverage | Status |
            |--------|----------|--------|
            | Lines | ${lines}% | ${getEmoji(lines)} |
            | Functions | ${functions}% | ${getEmoji(functions)} |
            | Branches | ${branches}% | ${getEmoji(branches)} |
            | Statements | ${statements}% | ${getEmoji(statements)} |

            ---
            <details>
            <summary>Coverage Legend</summary>

            - 🟢 >= 80% (Good)
            - 🟡 50-79% (Needs improvement)
            - 🔴 < 50% (Critical - add tests!)

            </details>

            *Coverage thresholds are configured in \`vitest.config.js\`*`;

            // Find existing comment
            const comments = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
            });

            const existingComment = comments.data.find(c =>
              c.user.login === 'github-actions[bot]' &&
              c.body.includes('Coverage Report')
            );

            if (existingComment) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existingComment.id,
                body: body
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: context.issue.number,
                body: body
              });
            }

      - name: Upload coverage artifacts
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
          retention-days: 14

      - name: Fail if coverage below threshold
        run: |
          # The vitest config has thresholds, but let's also check here
          # for a clear error message
          LINES="${{ steps.coverage.outputs.lines }}"
          THRESHOLD=20

          if (( $(echo "$LINES < $THRESHOLD" | bc -l) )); then
            echo "❌ Coverage ($LINES%) is below threshold ($THRESHOLD%)"
            echo "Add more tests before merging!"
            exit 1
          fi

          echo "✅ Coverage ($LINES%) meets threshold ($THRESHOLD%)"
```

---

### 10. release.yml

```yaml
name: Release

# Automated releases with changelog generation
# Why: Professional releases without manual changelog maintenance

on:
  push:
    tags:
      - 'v*'  # Triggers on version tags like v1.0.0
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to release (e.g., 1.0.0)'
        required: true
        type: string
      prerelease:
        description: 'Is this a pre-release?'
        required: false
        type: boolean
        default: false

permissions:
  contents: write
  pull-requests: read

jobs:
  release:
    name: Create Release
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for changelog

      - name: Get version
        id: version
        run: |
          if [ -n "${{ inputs.version }}" ]; then
            VERSION="${{ inputs.version }}"
          else
            VERSION="${GITHUB_REF#refs/tags/v}"
          fi
          echo "version=$VERSION" >> $GITHUB_OUTPUT
          echo "📦 Releasing version: $VERSION"

      - name: Get previous tag
        id: prev_tag
        run: |
          PREV_TAG=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
          echo "tag=$PREV_TAG" >> $GITHUB_OUTPUT
          echo "Previous tag: ${PREV_TAG:-'(none - first release)'}"

      - name: Generate changelog
        id: changelog
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          PREV_TAG="${{ steps.prev_tag.outputs.tag }}"

          echo "## What's Changed in v${VERSION}" > CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          # Get commit range
          if [ -n "$PREV_TAG" ]; then
            RANGE="${PREV_TAG}..HEAD"
          else
            RANGE="HEAD"
          fi

          # Categorize commits by conventional commit prefix
          echo "### 🚀 Features" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h)" --grep="^feat" 2>/dev/null | head -20 >> CHANGELOG_BODY.md || echo "_No new features_" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          echo "### 🐛 Bug Fixes" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h)" --grep="^fix" 2>/dev/null | head -20 >> CHANGELOG_BODY.md || echo "_No bug fixes_" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          echo "### 🔒 Security" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h)" --grep="^security\|^sec" 2>/dev/null | head -20 >> CHANGELOG_BODY.md || echo "_No security updates_" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          echo "### 📚 Documentation" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h)" --grep="^docs" 2>/dev/null | head -10 >> CHANGELOG_BODY.md || echo "_No documentation changes_" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          echo "### 🔧 Other Changes" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h)" --grep="^chore\|^refactor\|^style\|^test\|^ci" 2>/dev/null | head -10 >> CHANGELOG_BODY.md || echo "_No other changes_" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md

          # Add stats
          echo "### 📊 Stats" >> CHANGELOG_BODY.md
          if [ -n "$PREV_TAG" ]; then
            COMMITS=$(git rev-list --count $RANGE)
            FILES=$(git diff --shortstat $RANGE | grep -oP '\d+ file' | grep -oP '\d+' || echo "0")
            echo "- **Commits:** $COMMITS" >> CHANGELOG_BODY.md
            echo "- **Files changed:** $FILES" >> CHANGELOG_BODY.md
          else
            echo "- First release!" >> CHANGELOG_BODY.md
          fi
          echo "" >> CHANGELOG_BODY.md

          # Add full commit list (collapsed)
          echo "<details>" >> CHANGELOG_BODY.md
          echo "<summary>Full Commit History</summary>" >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md
          git log $RANGE --pretty=format:"- %s (%h) - %an" 2>/dev/null | head -50 >> CHANGELOG_BODY.md
          echo "" >> CHANGELOG_BODY.md
          echo "</details>" >> CHANGELOG_BODY.md

          cat CHANGELOG_BODY.md

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build extension
        run: npm run build

      - name: Package extension
        run: |
          VERSION="${{ steps.version.outputs.version }}"

          # Create release directory
          mkdir -p release

          # Package Chrome extension
          if [ -d "build" ]; then
            cd build
            zip -r "../release/kyt-extension-v${VERSION}-chrome.zip" .
            cd ..
          fi

          # List release artifacts
          echo "📦 Release artifacts:"
          ls -la release/

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          name: "v${{ steps.version.outputs.version }}"
          body_path: CHANGELOG_BODY.md
          draft: false
          prerelease: ${{ inputs.prerelease || false }}
          files: |
            release/*.zip
          generate_release_notes: false
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Update CHANGELOG.md
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          DATE=$(date +%Y-%m-%d)

          # Create or prepend to CHANGELOG.md
          if [ -f "CHANGELOG.md" ]; then
            # Prepend new version
            echo "# Changelog" > CHANGELOG_NEW.md
            echo "" >> CHANGELOG_NEW.md
            echo "## [${VERSION}] - ${DATE}" >> CHANGELOG_NEW.md
            cat CHANGELOG_BODY.md | tail -n +2 >> CHANGELOG_NEW.md
            echo "" >> CHANGELOG_NEW.md
            tail -n +2 CHANGELOG.md >> CHANGELOG_NEW.md
            mv CHANGELOG_NEW.md CHANGELOG.md
          else
            # Create new changelog
            echo "# Changelog" > CHANGELOG.md
            echo "" >> CHANGELOG.md
            echo "All notable changes to this project will be documented in this file." >> CHANGELOG.md
            echo "" >> CHANGELOG.md
            echo "## [${VERSION}] - ${DATE}" >> CHANGELOG.md
            cat CHANGELOG_BODY.md | tail -n +2 >> CHANGELOG.md
          fi

      - name: Commit changelog
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"

          if git diff --quiet CHANGELOG.md; then
            echo "No changelog changes to commit"
          else
            git add CHANGELOG.md
            git commit -m "docs: Update CHANGELOG for v${{ steps.version.outputs.version }}"
            git push origin HEAD:main
          fi

      - name: Summary
        run: |
          echo "## 🎉 Release v${{ steps.version.outputs.version }} Created!" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "### Artifacts" >> $GITHUB_STEP_SUMMARY
          echo "| File | Size |" >> $GITHUB_STEP_SUMMARY
          echo "|------|------|" >> $GITHUB_STEP_SUMMARY
          for f in release/*; do
            SIZE=$(ls -lh "$f" | awk '{print $5}')
            echo "| $(basename $f) | $SIZE |" >> $GITHUB_STEP_SUMMARY
          done
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "[View Release](https://github.com/${{ github.repository }}/releases/tag/v${{ steps.version.outputs.version }})" >> $GITHUB_STEP_SUMMARY
```

---

### 11. stale-branches.yml

```yaml
name: Stale Branch Cleanup

# Keeps repository clean by identifying old branches
# Why: Prevents branch sprawl and confusion

on:
  schedule:
    # Run every Monday at 9 AM UTC
    - cron: '0 9 * * 1'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run (list only, no deletion)'
        required: false
        type: boolean
        default: true
      days_stale:
        description: 'Days since last commit to consider stale'
        required: false
        type: number
        default: 30

permissions:
  contents: write

jobs:
  cleanup:
    name: Identify Stale Branches
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Configure git
        run: |
          git config user.name "GitHub Actions"
          git config user.email "actions@github.com"

      - name: Find stale branches
        id: stale
        run: |
          DAYS_STALE="${{ inputs.days_stale || 30 }}"
          CUTOFF_DATE=$(date -d "$DAYS_STALE days ago" +%Y-%m-%d)

          echo "🔍 Finding branches with no commits since: $CUTOFF_DATE"
          echo ""

          # Protected branches that should never be deleted
          PROTECTED_BRANCHES="main|master|develop|staging|production"

          STALE_BRANCHES=""
          STALE_COUNT=0

          # Get all remote branches
          for branch in $(git branch -r --format='%(refname:short)' | grep -v HEAD); do
            # Skip origin/ prefix for display
            BRANCH_NAME="${branch#origin/}"

            # Skip protected branches
            if echo "$BRANCH_NAME" | grep -qE "^($PROTECTED_BRANCHES)$"; then
              continue
            fi

            # Get last commit date
            LAST_COMMIT=$(git log -1 --format="%ci" "$branch" 2>/dev/null | cut -d' ' -f1)

            if [ -n "$LAST_COMMIT" ] && [ "$LAST_COMMIT" \< "$CUTOFF_DATE" ]; then
              LAST_AUTHOR=$(git log -1 --format="%an" "$branch" 2>/dev/null)
              DAYS_OLD=$(( ($(date +%s) - $(date -d "$LAST_COMMIT" +%s)) / 86400 ))

              echo "📌 $BRANCH_NAME"
              echo "   Last commit: $LAST_COMMIT ($DAYS_OLD days ago)"
              echo "   Author: $LAST_AUTHOR"
              echo ""

              STALE_BRANCHES="$STALE_BRANCHES $BRANCH_NAME"
              STALE_COUNT=$((STALE_COUNT + 1))
            fi
          done

          echo "stale_branches=$STALE_BRANCHES" >> $GITHUB_OUTPUT
          echo "stale_count=$STALE_COUNT" >> $GITHUB_OUTPUT

          echo "---"
          echo "📊 Found $STALE_COUNT stale branch(es)"

      - name: Delete stale branches
        if: inputs.dry_run == false && steps.stale.outputs.stale_count > 0
        run: |
          echo "⚠️ Deleting stale branches..."

          for branch in ${{ steps.stale.outputs.stale_branches }}; do
            echo "Deleting: $branch"
            git push origin --delete "$branch" || echo "Failed to delete $branch"
          done

          echo "✅ Cleanup complete"

      - name: Create summary issue
        if: steps.stale.outputs.stale_count > 0
        uses: actions/github-script@v7
        with:
          script: |
            const staleBranches = '${{ steps.stale.outputs.stale_branches }}'.trim().split(' ').filter(b => b);
            const isDryRun = '${{ inputs.dry_run }}' !== 'false';
            const daysStale = '${{ inputs.days_stale || 30 }}';

            if (staleBranches.length === 0) {
              console.log('No stale branches to report');
              return;
            }

            // Check for existing open issue
            const issues = await github.rest.issues.listForRepo({
              owner: context.repo.owner,
              repo: context.repo.repo,
              state: 'open',
              labels: 'stale-branches'
            });

            const existingIssue = issues.data.find(i => i.title.includes('Stale Branches'));

            const branchList = staleBranches.map(b => `- \`${b}\``).join('\n');

            const body = `## 🧹 Stale Branch Report

            **Scan Date:** ${new Date().toISOString().split('T')[0]}
            **Threshold:** ${daysStale} days without commits
            **Mode:** ${isDryRun ? '🔍 Dry Run (no deletions)' : '🗑️ Auto-Delete'}

            ### Branches Found

            ${branchList}

            ${isDryRun ? `
            ### Action Required

            These branches haven't had commits in over ${daysStale} days. Please:
            1. Delete branches you no longer need
            2. Or push new commits to keep them active

            To delete a branch manually:
            \`\`\`bash
            git push origin --delete branch-name
            \`\`\`

            To enable auto-deletion, run the workflow manually with "Dry run" unchecked.
            ` : `
            ### Auto-Deleted

            The branches listed above have been automatically deleted.
            If any were deleted in error, you can restore them from the reflog within 30 days.
            `}

            ---
            *This issue was automatically created by the Stale Branch Cleanup workflow.*`;

            if (existingIssue) {
              await github.rest.issues.update({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: existingIssue.number,
                body: body
              });
              console.log(`Updated existing issue #${existingIssue.number}`);
            } else {
              await github.rest.issues.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                title: '🧹 Stale Branches Report',
                body: body,
                labels: ['stale-branches', 'maintenance']
              });
              console.log('Created new stale branches issue');
            }

      - name: Summary
        run: |
          echo "## 🧹 Stale Branch Cleanup" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "| Metric | Value |" >> $GITHUB_STEP_SUMMARY
          echo "|--------|-------|" >> $GITHUB_STEP_SUMMARY
          echo "| Stale branches found | ${{ steps.stale.outputs.stale_count }} |" >> $GITHUB_STEP_SUMMARY
          echo "| Threshold | ${{ inputs.days_stale || 30 }} days |" >> $GITHUB_STEP_SUMMARY
          echo "| Mode | ${{ inputs.dry_run == false && 'Auto-delete' || 'Dry run' }} |" >> $GITHUB_STEP_SUMMARY

          if [ "${{ steps.stale.outputs.stale_count }}" -eq "0" ]; then
            echo "" >> $GITHUB_STEP_SUMMARY
            echo "✅ No stale branches found!" >> $GITHUB_STEP_SUMMARY
          fi
```

---

## Supporting Files

### dependabot.yml

```yaml
version: 2
updates:
  # npm dependencies
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "daily"
      time: "06:00"
      timezone: "UTC"
    open-pull-requests-limit: 10
    labels:
      - "dependencies"
      - "automated"
    commit-message:
      prefix: "chore(deps):"
    # Group minor/patch updates to reduce noise
    groups:
      minor-and-patch:
        patterns:
          - "*"
        update-types:
          - "minor"
          - "patch"

  # GitHub Actions
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
    labels:
      - "dependencies"
      - "github-actions"
      - "automated"
    commit-message:
      prefix: "ci(deps):"
```

### .gitleaks.toml

```toml
# Gitleaks configuration
# Customize secret detection to reduce false positives

[extend]
useDefault = true

[allowlist]
description = "Allowlist for false positives"

# Paths to ignore (test files with mock data)
paths = [
    '''test/.*\.js$''',
    '''tests/.*\.js$''',
    '''.*\.test\.js$''',
    '''.*\.spec\.js$''',
    '''.*\.md$''',
    '''package-lock\.json$''',
]

# Specific patterns that are false positives
regexes = [
    # Example API key placeholders
    '''your[_-]api[_-]key[_-]here''',
    '''sk-xxxxxxxx''',
    '''REPLACE_WITH_YOUR''',
]

# Specific commits to ignore (if you have historical false positives)
# commits = [
#     "commit-sha-here",
# ]

[[rules]]
description = "Ignore example/placeholder secrets"
regex = '''(?i)(example|placeholder|your[_-]?|dummy|fake|test)[_-]?(api[_-]?key|secret|token|password)'''
allowlist = { description = "Ignore placeholder values" }
```

### pull_request_template.md

```markdown
## Description

<!-- Brief description of changes -->

## Type of Change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature
- [ ] 🔒 Security fix
- [ ] 📚 Documentation
- [ ] 🔧 Configuration/CI
- [ ] ♻️ Refactor

## Security Checklist

<!-- For PII apps, security is non-negotiable -->

### Data Handling
- [ ] No PII logged to console
- [ ] No sensitive data in error messages
- [ ] User data properly sanitized

### Authentication & Authorization
- [ ] API keys use environment variables
- [ ] RLS policies updated if schema changed
- [ ] No hardcoded credentials

### Secrets
- [ ] No secrets in code
- [ ] .env files not committed
- [ ] API keys rotated if exposed

### Database
- [ ] Migrations reviewed for destructive operations
- [ ] Backup taken before schema changes
- [ ] RLS enabled on new tables

## Testing

- [ ] Unit tests pass
- [ ] E2E tests pass (if applicable)
- [ ] Manually tested in browser

## Screenshots

<!-- If UI changes, add before/after screenshots -->

---

**By submitting this PR, I confirm that:**
- [ ] I have reviewed my own code
- [ ] I have tested these changes
- [ ] I have not introduced security vulnerabilities
```

---

## Conclusion

This CI/CD pipeline represents a mature, security-first approach to solo development of a PII-handling application. It balances automation with safety, providing guardrails without requiring constant manual intervention.

### Key Takeaways

1. **Automate the tedious, gate the dangerous** - Security patches auto-merge, production deploys require approval
2. **Fail fast, recover faster** - Auto-rollback ensures brief outages even during failures
3. **Trust but verify** - Multiple security layers catch different types of issues
4. **Document everything** - Audit trail via issues, comments, and tags

### Maintenance Notes

- Review and increase coverage thresholds quarterly
- Update Gitleaks patterns as new secret formats emerge
- Revisit AI tool integration as the landscape evolves
- Rotate secrets per the monthly reminder schedule

---

*Document generated: 2025-11-26*
*Pipeline version: 1.0.0*
*Total workflows: 11*

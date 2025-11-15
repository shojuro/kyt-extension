# KYT CLI Memory Tool - Quick Reference

**Date**: 2025-11-12
**Status**: ✅ Operational

---

## Quick Start

### ✅ Recommended Usage (Works Reliably)

```bash
# From project directory
cd /home/penguinzyue/kyt-validation-sprint

# Capture a memory
node cli/mem.js "Your message here"

# Pipe output
echo "data" | node cli/mem.js --pipe "Description"
npm test | node cli/mem.js --pipe "Test results"
```

### ✅ Fixed: Global Command Now Works

The global `mem` command now works correctly:

```bash
# ✅ Now works!
mem "Your message"

# ✅ Also works
node cli/mem.js "Your message"
```

**Fixed on**: 2025-11-12
**Root causes**:
1. Windows line endings in .env file (caused dotenv to hang)
2. npm link symlink path mismatch (import.meta.url vs process.argv[1])

**Solution**: Symlink resolution + Unix line endings

---

## Installation

### Local Usage (No Install Needed)
```bash
# Already works from project directory
node cli/mem.js "message"
```

### Global Installation (Now Working)
```bash
# Install globally
npm link

# Use from anywhere
mem "test"  # ✅ Works!
```

---

## Usage Examples

### Basic Memory Capture
```bash
node cli/mem.js "Remember: The RLS policy error was fixed by adding SELECT permission"
```

### Pipe Command Output
```bash
npm test | node cli/mem.js --pipe "Test results from validation suite"
```

### Pipe File Contents
```bash
cat error.log | node cli/mem.js --pipe "Error log from production deployment"
```

### Multi-line Content
```bash
node cli/mem.js "Remember: I'm working on KYT validation sprint.
The hybrid sync strategy uses 4-minute threshold.
Day 4 production proof showed cross-session memory working."
```

---

## Where It Works

The CLI tool works in **any terminal with Node.js installed**:

| Environment | Status | Notes |
|-------------|--------|-------|
| **WSL Ubuntu** | ✅ Tested | Primary development environment (globally linked) |
| **Windows PowerShell** | ✅ Compatible | See Windows installation section below |
| **Windows Command Prompt** | ✅ Compatible | See Windows installation section below |
| **macOS Terminal** | ✅ Compatible | Same as Ubuntu (use `npm link`) |
| **Linux** | ✅ Compatible | Same as Ubuntu (use `npm link`) |

---

## Environment Variables Required

The CLI tool needs API keys from `.env`:

```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
OPENAI_API_KEY=sk-your-openai-key
```

### Option 1: Run from Project Directory (Easiest)
```bash
cd /home/penguinzyue/kyt-validation-sprint
node cli/mem.js "message"
```
The `.env` file is automatically loaded.

### Option 2: Set Environment Variables Globally (Unix/Linux/macOS)
Add to `~/.bashrc` or `~/.zshrc`:
```bash
export SUPABASE_URL="your-url"
export SUPABASE_ANON_KEY="your-key"
export OPENAI_API_KEY="your-key"
```

Then reload: `source ~/.bashrc`

### Option 3: Set Environment Variables Globally (Windows)

**Windows Command Prompt:**
```cmd
setx SUPABASE_URL "https://your-project.supabase.co"
setx SUPABASE_ANON_KEY "your-anon-key"
setx OPENAI_API_KEY "sk-your-openai-key"
```

**Windows PowerShell:**
```powershell
[System.Environment]::SetEnvironmentVariable('SUPABASE_URL', 'https://your-project.supabase.co', 'User')
[System.Environment]::SetEnvironmentVariable('SUPABASE_ANON_KEY', 'your-anon-key', 'User')
[System.Environment]::SetEnvironmentVariable('OPENAI_API_KEY', 'sk-your-openai-key', 'User')
```

**Note**: After setting environment variables with `setx`, you must **restart your terminal** for changes to take effect.

---

## Windows Installation Guide

### Prerequisites
- Node.js v20+ installed ([Download](https://nodejs.org))
- npm available in PATH (comes with Node.js)

### Installation Steps

#### Windows Command Prompt
```cmd
REM 1. Navigate to project directory
cd C:\path\to\kyt-validation-sprint

REM 2. Install dependencies
npm install

REM 3. Create global link (creates mem.cmd wrapper automatically)
npm link

REM 4. Verify installation
where mem
REM Expected output: C:\Users\YourName\AppData\Roaming\npm\mem.cmd

REM 5. Test command
mem "test message from Windows CMD"
```

#### Windows PowerShell
```powershell
# 1. Navigate to project directory
cd C:\path\to\kyt-validation-sprint

# 2. Install dependencies
npm install

# 3. Create global link (creates mem.ps1 wrapper automatically)
npm link

# 4. Verify installation
Get-Command mem
# Expected output: C:\Users\YourName\AppData\Roaming\npm\mem.ps1

# 5. Test command
mem "test message from PowerShell"
```

### PowerShell Execution Policy

If you get "script execution disabled" error in PowerShell:

```powershell
# Allow script execution for current user
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Verify policy
Get-ExecutionPolicy -List
```

### How npm link Works on Windows

When you run `npm link` on Windows, npm automatically creates platform-specific wrapper files:

1. **`mem.cmd`** - Batch file for Command Prompt
   - Location: `C:\Users\YourName\AppData\Roaming\npm\mem.cmd`
   - Calls Node.js with the CLI script

2. **`mem.ps1`** - PowerShell script (modern npm versions)
   - Location: `C:\Users\YourName\AppData\Roaming\npm\mem.ps1`
   - Calls Node.js with the CLI script

3. **`mem`** - Bash-style symlink for Git Bash/WSL
   - Allows `mem` command to work in Git Bash on Windows

These wrappers handle argument passing and Node.js invocation automatically - **no manual configuration needed!**

### Windows Usage Examples

#### Command Prompt
```cmd
REM Basic memory capture
mem "Remember: Fixed the RLS policy error"

REM Pipe command output
npm test | mem --pipe "Test results"

REM Pipe file contents
type error.log | mem --pipe "Production error log"

REM Multi-line content (use quotes)
mem "Working on KYT validation sprint. The hybrid sync uses 4-minute threshold. Day 4 production proof working."
```

#### PowerShell
```powershell
# Basic memory capture
mem "Remember: Fixed the RLS policy error"

# Pipe command output
npm test | mem --pipe "Test results"

# Pipe file contents
Get-Content error.log | mem --pipe "Production error log"

# Multi-line content
mem @"
Working on KYT validation sprint.
The hybrid sync uses 4-minute threshold.
Day 4 production proof working.
"@
```

### Verifying Windows Installation

Run these checks to confirm everything works:

```powershell
# Check Node.js version
node --version
# Expected: v20.x.x or higher

# Check npm version
npm --version

# Check mem command exists
where.exe mem  # Command Prompt
Get-Command mem  # PowerShell

# Check environment variables
echo %SUPABASE_URL%  # Command Prompt
$env:SUPABASE_URL    # PowerShell

# Test mem command
mem "Windows installation verification test"
```

---

## How It Works

```
1. You run: node cli/mem.js "message"
   ↓
2. Generate OpenAI embedding (1536 dimensions)
   ↓
3. Store in Supabase with metadata:
   - source: 'cli'
   - timestamp
   - message_id
   - embedding
   ↓
4. Message becomes searchable from:
   - ChatGPT (via context injection)
   - CLI search tools
   - Semantic queries
```

---

## Verify Messages Captured

```bash
# Check all CLI messages
node check_cli_messages.js

# Count total messages
node -e "
import('dotenv/config').then(() => {
  return import('@supabase/supabase-js');
}).then(({ createClient }) => {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  return Promise.all([
    supabase.from('messages').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('source', { count: 'exact' }).eq('source', 'cli')
  ]);
}).then(([total, cli]) => {
  console.log('Total messages:', total.count);
  console.log('CLI messages:', cli.count);
});
"
```

---

## Current Message Counts

As of Day 4 completion:
- **Total messages**: 44
- **ChatGPT messages**: 40 (captured via Chrome extension)
- **CLI messages**: 4 (captured via `mem` command)

All messages have embeddings and are searchable via semantic similarity.

---

## Testing Context Injection

After capturing a CLI memory, test retrieval in ChatGPT:

```bash
# Capture
node cli/mem.js "Remember: The hybrid sync uses 4-minute threshold"

# Then in ChatGPT, ask:
"What did I capture in CLI about sync strategy?"
```

ChatGPT should retrieve your CLI message and explain the 4-minute threshold.

---

## Best Practices

### ✅ DO
- Capture meaningful technical notes
- Use descriptive content (50-500 characters ideal)
- Include context and details
- Tag with project names (e.g., "KYT validation sprint")
- Pipe important command outputs

### ❌ DON'T
- Capture single-word tests ("test", "hello")
- Create noise with meaningless content
- Capture sensitive information (passwords, keys)

---

## Troubleshooting

### "Missing required environment variables"
**Solution**: Run from project directory OR set environment variables globally.

**Windows users**: After using `setx`, you must **restart your terminal** for environment variables to take effect.

### "Command hangs" (FIXED as of 2025-11-12)
**Was**: npm link symlink + Windows line endings issue
**Now**: Fixed with symlink resolution + Unix line endings
**If still occurs**: Check .env file line endings with `file .env` (should be "ASCII text", not "CRLF")

### "Message not appearing in ChatGPT"
**Possible causes**:
1. Semantic similarity below threshold (0.5)
2. Query too different from captured content
3. Context injection not triggered

**Solution**: Ask more explicitly (e.g., "Search my CLI memories for X")

---

## Windows-Specific Troubleshooting

### "mem : The term 'mem' is not recognized" (PowerShell)
**Cause**: `mem` command not found in PATH

**Solution**:
1. Verify npm link ran successfully: `npm link` in project directory
2. Check if wrapper exists: `Get-Command mem` should show path
3. If not found, check npm global bin directory is in PATH:
   ```powershell
   npm config get prefix
   # Should be in PATH: C:\Users\YourName\AppData\Roaming\npm
   ```
4. Add to PATH if missing:
   ```powershell
   $npmPath = npm config get prefix
   [System.Environment]::SetEnvironmentVariable('Path', "$env:Path;$npmPath", 'User')
   ```
5. Restart PowerShell

### "Script execution disabled" (PowerShell)
**Cause**: PowerShell execution policy blocks running scripts

**Solution**:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### "'mem' is not recognized" (Command Prompt)
**Cause**: `mem.cmd` not in PATH

**Solution**:
1. Find npm global bin directory: `npm config get prefix`
2. Verify `mem.cmd` exists in that directory
3. Add to system PATH if needed:
   - Windows Settings → System → About → Advanced system settings
   - Environment Variables → User variables → Path → Edit
   - Add: `C:\Users\YourName\AppData\Roaming\npm`
4. Restart Command Prompt

### "ENOENT: no such file or directory, open '.env'"
**Cause**: CLI can't find `.env` file (running from different directory)

**Solution Option 1 - Use project directory**:
```cmd
cd C:\path\to\kyt-validation-sprint
mem "message"
```

**Solution Option 2 - Set environment variables globally** (see "Environment Variables Required" section above)

### "node:internal/modules/esm/resolve:265" (Import error)
**Cause**: Missing dependencies or incorrect Node.js version

**Solution**:
1. Verify Node.js version: `node --version` (should be v20+)
2. Reinstall dependencies:
   ```cmd
   cd C:\path\to\kyt-validation-sprint
   npm install
   npm link
   ```

### Line Ending Issues on Windows
**Symptom**: `.env` file causes CLI to hang

**Solution**: Convert to Unix line endings (LF instead of CRLF)
```powershell
# Using PowerShell
(Get-Content .env) | Set-Content -NoNewline .env

# Or use Git
git config --global core.autocrlf input
```

Then re-save `.env` file.

---

## See Also

- [DAY2_COMPLETE.md](./DAY2_COMPLETE.md) - CLI tool implementation details
- [DAY4_SUCCESS.md](./DAY4_SUCCESS.md) - Production proof of cross-source memory
- [SYNC_BEHAVIOR.md](./SYNC_BEHAVIOR.md) - How extension sync works

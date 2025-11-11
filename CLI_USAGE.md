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

### ⚠️ Known Issue: Global Command

The global `mem` command has argument-passing issues:

```bash
# ❌ May hang or not work correctly
mem "Your message"

# ✅ Use this instead
node cli/mem.js "Your message"
```

**Root cause**: Issue with how npm link passes arguments to the script.

---

## Installation

### Local Usage (No Install Needed)
```bash
# Already works from project directory
node cli/mem.js "message"
```

### Global Installation (Optional, Has Issues)
```bash
# Install globally
npm link

# Try using it
mem "test"  # May hang - use node cli/mem.js instead
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
| **WSL Ubuntu** | ✅ Tested | Primary development environment |
| **Windows PowerShell** | ✅ Should work | Requires Node.js installed |
| **Windows Command Prompt** | ✅ Should work | Requires Node.js installed |
| **macOS Terminal** | ✅ Should work | Requires Node.js installed |
| **Linux** | ✅ Should work | Requires Node.js installed |

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

### Option 2: Set Environment Variables Globally
Add to `~/.bashrc` or `~/.zshrc`:
```bash
export SUPABASE_URL="your-url"
export SUPABASE_ANON_KEY="your-key"
export OPENAI_API_KEY="your-key"
```

Then reload: `source ~/.bashrc`

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
- Rely on global `mem` command (use `node cli/mem.js` instead)

---

## Troubleshooting

### "Missing required environment variables"
**Solution**: Run from project directory OR set environment variables globally.

### "Command hangs"
**Solution**: Don't use global `mem` command. Use `node cli/mem.js` instead.

### "Message not appearing in ChatGPT"
**Possible causes**:
1. Semantic similarity below threshold (0.5)
2. Query too different from captured content
3. Context injection not triggered

**Solution**: Ask more explicitly (e.g., "Search my CLI memories for X")

---

## See Also

- [DAY2_COMPLETE.md](./DAY2_COMPLETE.md) - CLI tool implementation details
- [DAY4_SUCCESS.md](./DAY4_SUCCESS.md) - Production proof of cross-source memory
- [SYNC_BEHAVIOR.md](./SYNC_BEHAVIOR.md) - How extension sync works

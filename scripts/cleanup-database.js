/**
 * KYT Database Cleanup Script
 *
 * Purpose: Remove CSS, JavaScript, and UI noise from captured messages
 *
 * This script identifies and deletes polluted entries from the Supabase database
 * that were incorrectly captured by the DOM observer before filters were improved.
 *
 * Usage:
 *   node scripts/cleanup-database.js --dry-run   # Preview what would be deleted
 *   node scripts/cleanup-database.js             # Actually delete noise entries
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) required in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Noise detection patterns
const NOISE_PATTERNS = {
  css: [
    /^\s*\.[\w-]+\s*\{/,           // CSS class selectors
    /^\s*#[\w-]+\s*\{/,            // CSS ID selectors
    /^[\s\w-]+:\s*[\w\s#(),.-]+;/, // CSS properties
    /@media|@keyframes|@import|@font-face/i, // CSS at-rules
    /!important/i,                  // !important
    /:\s*var\(--[\w-]+\)/,         // CSS variables
    /\.ant-[\w-]+/,                 // Ant Design classes
    /background-color|color:|padding:|margin:|z-index/i // Common CSS properties
  ],

  javascript: [
    /window\.|document\./,
    /function\s*\(/,
    /const\s+\w+\s*=/,
    /let\s+\w+\s*=/,
    /var\s+\w+\s*=/,
    /=>\s*\{/,
    /console\.(log|error|warn)/,
    /__oai_|__webpack_|__SSR_/,
    /requestAnimationFrame|MutationObserver|OriginalWebSocket/,
    /\[\[Prototype\]\]/,           // Console object inspection
    /Symbol\(Symbol\./,             // Symbol properties
    /ƒ\s+\w+\(\)/,                 // Function representations (ƒ at(), ƒ map())
    /Array\(0\)/                    // Array constructor in console
  ],

  ui: [
    /^(ChatGPT|Log in|Sign up|Attach|Search|Study|Create image|Voice|New chat)$/i,
    /^(Temporary Chat|This chat won|For safety purposes)/i,
    /Terms|Privacy Policy|messaging ChatGPT/i,
    /Where should we begin/i,
    /Send a message/i,
    /^Chat history/i
  ],

  repeated: [
    /^(ChatGPT){2,}/,  // "ChatGPTChatGPT"
    /^(Log in){2,}/     // "Log inLog in"
  ],

  metadata: [
    /\[Memory Context - \d+ relevant item/i,  // "[Memory Context - 3 relevant items]"
    /\[End of Memory Context\]/i,             // "[End of Memory Context]"
    /💬 Previous conversation/,                // "💬 Previous conversation"
    /📝 Terminal/                              // "📝 Terminal"
  ]
};

/**
 * Check if content matches noise patterns
 */
function isNoise(content) {
  if (!content || typeof content !== 'string') return false;

  const categories = [];

  // Check CSS patterns
  if (NOISE_PATTERNS.css.some(pattern => pattern.test(content))) {
    categories.push('CSS');
  }

  // Check JavaScript patterns
  if (NOISE_PATTERNS.javascript.some(pattern => pattern.test(content))) {
    categories.push('JavaScript');
  }

  // Check UI patterns
  if (NOISE_PATTERNS.ui.some(pattern => pattern.test(content))) {
    categories.push('UI Element');
  }

  // Check repeated patterns
  if (NOISE_PATTERNS.repeated.some(pattern => pattern.test(content))) {
    categories.push('Repeated Text');
  }

  // Check memory context metadata
  if (NOISE_PATTERNS.metadata.some(pattern => pattern.test(content))) {
    categories.push('Memory Context Metadata');
  }

  return categories.length > 0 ? categories : null;
}

/**
 * Scan messages table for noise entries
 */
async function scanMessages(dryRun = true) {
  console.log('🔍 Scanning messages table for noise...\n');

  // Fetch all messages (in batches to avoid memory issues)
  let allMessages = [];
  let start = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('messages')
      .select('id, content, role, created_at')
      .range(start, start + batchSize - 1);

    if (error) {
      console.error('❌ Error fetching messages:', error.message);
      break;
    }

    if (!data || data.length === 0) break;

    allMessages = allMessages.concat(data);
    start += batchSize;

    process.stdout.write(`\r📊 Fetched ${allMessages.length} messages...`);

    if (data.length < batchSize) break;
  }

  console.log(`\n\n✅ Fetched ${allMessages.length} total messages\n`);

  // Analyze messages
  const noiseMessages = [];
  const noiseCategoryCounts = {
    'CSS': 0,
    'JavaScript': 0,
    'UI Element': 0,
    'Repeated Text': 0,
    'Memory Context Metadata': 0
  };

  for (const message of allMessages) {
    const categories = isNoise(message.content);
    if (categories) {
      noiseMessages.push({
        ...message,
        noiseCategories: categories
      });

      categories.forEach(cat => {
        noiseCategoryCounts[cat]++;
      });
    }
  }

  // Report findings
  console.log('📊 SCAN RESULTS');
  console.log('═'.repeat(60));
  console.log(`Total messages:     ${allMessages.length}`);
  console.log(`Clean messages:     ${allMessages.length - noiseMessages.length}`);
  console.log(`Noise messages:     ${noiseMessages.length}`);
  console.log(`Noise percentage:   ${((noiseMessages.length / allMessages.length) * 100).toFixed(1)}%\n`);

  console.log('📊 NOISE BREAKDOWN');
  console.log('─'.repeat(60));
  for (const [category, count] of Object.entries(noiseCategoryCounts)) {
    console.log(`${category.padEnd(20)} ${count} messages`);
  }
  console.log('');

  // Show examples
  if (noiseMessages.length > 0) {
    console.log('📝 SAMPLE NOISE (first 5 entries)');
    console.log('─'.repeat(60));

    for (let i = 0; i < Math.min(5, noiseMessages.length); i++) {
      const msg = noiseMessages[i];
      console.log(`\nID: ${msg.id}`);
      console.log(`Categories: ${msg.noiseCategories.join(', ')}`);
      console.log(`Preview: ${msg.content.substring(0, 150).replace(/\n/g, ' ')}...`);
    }
    console.log('\n');
  }

  // Perform cleanup if not dry run
  if (!dryRun && noiseMessages.length > 0) {
    console.log('🗑️ DELETING NOISE MESSAGES');
    console.log('═'.repeat(60));

    const ids = noiseMessages.map(m => m.id);
    let deleted = 0;

    // Delete in batches of 100
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);

      const { error } = await supabase
        .from('messages')
        .delete()
        .in('id', batch);

      if (error) {
        console.error(`❌ Error deleting batch ${i / 100 + 1}:`, error.message);
      } else {
        deleted += batch.length;
        process.stdout.write(`\r🗑️ Deleted ${deleted}/${ids.length} noise messages...`);
      }
    }

    console.log(`\n✅ Cleanup complete! Deleted ${deleted} noise messages\n`);
  } else if (dryRun && noiseMessages.length > 0) {
    console.log('💡 DRY RUN MODE - No changes made');
    console.log('   Run without --dry-run to actually delete these entries\n');
  } else {
    console.log('✨ No noise found! Database is clean.\n');
  }

  return {
    total: allMessages.length,
    clean: allMessages.length - noiseMessages.length,
    noise: noiseMessages.length,
    deleted: dryRun ? 0 : noiseMessages.length
  };
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('\n' + '═'.repeat(60));
  console.log('  KYT DATABASE CLEANUP');
  console.log('  Remove CSS, JavaScript, and UI noise from messages');
  console.log('═'.repeat(60) + '\n');

  if (dryRun) {
    console.log('🔍 Running in DRY RUN mode (no changes will be made)\n');
  } else {
    console.log('⚠️ Running in LIVE mode (will delete noise entries)\n');
  }

  const results = await scanMessages(dryRun);

  console.log('═'.repeat(60));
  console.log('  SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Clean messages:     ${results.clean}`);
  console.log(`Noise removed:      ${results.deleted}`);
  console.log(`Final count:        ${results.total - results.deleted}`);
  console.log('═'.repeat(60) + '\n');
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});

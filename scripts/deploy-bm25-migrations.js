#!/usr/bin/env node
/**
 * Deploy BM25 Migrations to Supabase
 *
 * Usage: node scripts/deploy-bm25-migrations.js
 *
 * Requires environment variables:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   SUPABASE_URL:', SUPABASE_URL ? '✓' : '✗');
  console.error('   SUPABASE_SERVICE_KEY:', SUPABASE_KEY ? '✓' : '✗');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Migration files in order
const migrations = [
  '20251209000000_add_bm25_tsvector.sql',
  '20251209000001_bm25_search_function.sql'
];

async function runMigration(filename) {
  const filepath = join(__dirname, '..', 'supabase', 'migrations', filename);

  try {
    const sql = readFileSync(filepath, 'utf8');
    console.log(`\n📝 Running migration: ${filename}`);

    // Split into individual statements (simple approach)
    // Note: This may not handle all SQL correctly - complex migrations
    // should be deployed via supabase db push
    const statements = sql
      .split(/;\s*$/m)
      .filter(s => s.trim())
      .filter(s => !s.trim().startsWith('--'));

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i].trim();
      if (!stmt) continue;

      // Execute via RPC if available, or use raw fetch
      const { data, error } = await supabase.rpc('exec_sql', { sql: stmt + ';' }).single();

      if (error) {
        // Try direct execution for DDL statements
        console.log(`   Statement ${i + 1}/${statements.length}...`);
        // For DDL, we need to use a different approach - log and continue
        if (error.message.includes('Could not find')) {
          console.log(`   ⚠️  RPC not available, skipping statement ${i + 1}`);
          continue;
        }
        throw error;
      }

      console.log(`   ✅ Statement ${i + 1}/${statements.length} complete`);
    }

    console.log(`✅ Migration complete: ${filename}`);
    return true;
  } catch (error) {
    console.error(`❌ Migration failed: ${filename}`);
    console.error(`   Error: ${error.message}`);
    return false;
  }
}

async function verifyFunction(functionName) {
  console.log(`\n🔍 Verifying function exists: ${functionName}`);

  try {
    // Try to call the function with test parameters
    const { data, error } = await supabase.rpc(functionName, {
      query_text: 'test',
      match_count: 1,
      exclude_recent_seconds: 0,
      p_user_id: '00000000-0000-0000-0000-000000000001'
    });

    if (error && error.message.includes('Could not find')) {
      console.log(`   ❌ Function not found: ${functionName}`);
      return false;
    }

    console.log(`   ✅ Function exists: ${functionName}`);
    return true;
  } catch (error) {
    console.log(`   ⚠️  Verification error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('🚀 BM25 Migration Deployment');
  console.log('============================');
  console.log(`   Database: ${SUPABASE_URL}`);

  // Check if function already exists
  const functionExists = await verifyFunction('match_messages_with_bm25');

  if (functionExists) {
    console.log('\n✅ BM25 function already exists!');
    console.log('   Migration may have been applied previously.');
    return;
  }

  console.log('\n⚠️  BM25 function not found.');
  console.log('   Migrations must be deployed via Supabase Dashboard or CLI.');
  console.log('');
  console.log('📋 Manual deployment steps:');
  console.log('   1. Go to Supabase Dashboard > SQL Editor');
  console.log('   2. Run each migration file in order:');

  for (const migration of migrations) {
    console.log(`      - supabase/migrations/${migration}`);
  }

  console.log('');
  console.log('   Or use Supabase CLI:');
  console.log('   $ supabase link --project-ref <your-project-ref>');
  console.log('   $ supabase db push');
}

main().catch(console.error);

#!/usr/bin/env node

/**
 * KYT Day 2: Direct SQL Execution for Supabase Setup
 *
 * This script uses the Supabase Management API to execute SQL directly
 * Reads SQL from supabase_schema.sql and applies it to the database
 */

require('dotenv').config();
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERROR: Missing credentials in .env');
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Extract project reference from URL (e.g., svrcvfzlwhnixzuxaccf from https://svrcvfzlwhnixzuxaccf.supabase.co)
const projectRef = SUPABASE_URL.match(/https?:\/\/([^.]+)/)[1];

async function executeSQLQuery(sql) {
  // Use Supabase's SQL query endpoint
  const url = `${SUPABASE_URL}/rest/v1/rpc/exec`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ query: sql })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    // If the endpoint doesn't exist, we'll need manual setup
    throw error;
  }
}

async function setupDatabase() {
  console.log('🚀 Starting Supabase database setup...\n');
  console.log(`📍 Project: ${projectRef}`);
  console.log(`🔗 URL: ${SUPABASE_URL}\n`);

  try {
    // Read SQL file
    console.log('📄 Reading SQL schema from supabase_schema.sql...');
    const sqlContent = fs.readFileSync('supabase_schema.sql', 'utf8');

    // Split SQL into individual statements
    // Skip comments and empty statements
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => {
        if (s.length === 0) return false;
        if (s.startsWith('--')) return false;
        // Keep CREATE, ALTER, but skip standalone SELECTs used for verification
        if (s.match(/^SELECT.*FROM\s+(pg_extension|information_schema|pg_indexes)/i)) return false;
        return true;
      });

    console.log(`📝 Found ${statements.length} SQL statements\n`);

    // Try to execute via API first
    console.log('⚙️  Attempting automated SQL execution...');

    let apiWorked = false;
    for (let i = 0; i < Math.min(statements.length, 1); i++) {
      try {
        await executeSQLQuery(statements[i] + ';');
        apiWorked = true;
        console.log('✅ API execution working!');
        break;
      } catch (error) {
        console.log('⚠️  API execution not available:', error.message);
        break;
      }
    }

    if (!apiWorked) {
      console.log('\n📝 Manual Setup Required:');
      console.log('─'.repeat(60));
      console.log('\nThe Supabase REST API does not support direct SQL execution.');
      console.log('Please follow these steps:\n');
      console.log('1. Open the Supabase SQL Editor:');
      console.log(`   https://supabase.com/dashboard/project/${projectRef}/sql/new\n`);
      console.log('2. Copy the entire contents of: supabase_schema.sql\n');
      console.log('3. Paste into the SQL Editor and click "Run"\n');
      console.log('4. Run this script again to verify setup:\n');
      console.log('   node setup_supabase.js\n');
      console.log('─'.repeat(60));

      // Show a preview of what needs to be run
      console.log('\n📋 SQL Preview (first 500 chars):');
      console.log('─'.repeat(60));
      console.log(sqlContent.substring(0, 500) + '...');
      console.log('─'.repeat(60));

      return false;
    }

    // If API worked, execute all statements
    console.log('\n⚙️  Executing SQL statements...');
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      console.log(`  [${i + 1}/${statements.length}] Executing...`);

      try {
        await executeSQLQuery(stmt + ';');
        successCount++;
        console.log(`  ✅ Success`);
      } catch (error) {
        errorCount++;
        console.log(`  ⚠️  Failed: ${error.message}`);
      }
    }

    console.log(`\n📊 Results: ${successCount} succeeded, ${errorCount} failed\n`);

    if (successCount > 0) {
      console.log('🎉 Database setup complete!');
      return true;
    } else {
      console.log('❌ All statements failed. Manual setup required.');
      return false;
    }

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.log('\nPlease use manual setup method described above.');
    return false;
  }
}

setupDatabase()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

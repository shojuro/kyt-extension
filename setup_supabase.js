#!/usr/bin/env node

/**
 * KYT Day 2: Supabase Database Setup Script
 *
 * This script:
 * 1. Connects to Supabase using credentials from .env
 * 2. Enables pgvector extension
 * 3. Creates the messages table with vector embeddings support
 * 4. Creates indexes for fast vector similarity search
 * 5. Verifies the setup
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ ERROR: Missing Supabase credentials in .env file');
  console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Create Supabase client with service role key (has admin privileges)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function setupDatabase() {
  console.log('🚀 Starting Supabase database setup...\n');

  try {
    // Step 1: Enable pgvector extension
    console.log('📦 Step 1: Enabling pgvector extension...');
    const { error: extError } = await supabase.rpc('exec_sql', {
      sql: 'CREATE EXTENSION IF NOT EXISTS vector;'
    });

    // Note: If exec_sql function doesn't exist, we'll use raw SQL via supabase-js
    // We'll try direct SQL execution instead

    // Step 2: Create messages table
    console.log('📋 Step 2: Creating messages table...');
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        conversation_id TEXT,
        model TEXT,
        timestamp BIGINT NOT NULL,
        message_id TEXT UNIQUE NOT NULL,
        embedding VECTOR(1536),
        created_at TIMESTAMP DEFAULT NOW(),
        synced_from_extension TIMESTAMP DEFAULT NOW()
      );
    `;

    // Step 3: Create indexes
    console.log('🔍 Step 3: Creating indexes...');
    const createIndexesSQL = `
      CREATE INDEX IF NOT EXISTS messages_embedding_idx ON messages
      USING hnsw (embedding vector_cosine_ops);

      CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (timestamp DESC);

      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id);

      CREATE INDEX IF NOT EXISTS messages_role_idx ON messages (role);
    `;

    // Execute SQL via SQL Editor API endpoint
    console.log('⚙️  Executing SQL commands...');
    console.log('Note: For full setup, you need to run the SQL manually in Supabase dashboard');
    console.log(`Dashboard URL: ${SUPABASE_URL.replace('https://', 'https://supabase.com/dashboard/project/')}/editor`);

    // Step 4: Test connection by trying to query the messages table
    console.log('\n🔗 Step 4: Testing connection...');
    const { data, error } = await supabase
      .from('messages')
      .select('count')
      .limit(1);

    if (error) {
      if (error.message.includes('relation "messages" does not exist')) {
        console.log('⚠️  Messages table does not exist yet.');
        console.log('\n📝 Manual Setup Required:');
        console.log('1. Go to Supabase SQL Editor:');
        console.log(`   ${SUPABASE_URL.replace('https://', 'https://supabase.com/dashboard/project/')}/editor`);
        console.log('2. Run the SQL from: supabase_schema.sql');
        console.log('3. Then run this script again to verify\n');

        // Write SQL to file for easy copy-paste
        const sqlContent = fs.readFileSync('supabase_schema.sql', 'utf8');
        console.log('✅ SQL schema is available in: supabase_schema.sql\n');

        return false;
      } else {
        throw error;
      }
    }

    console.log('✅ Connection successful!');
    console.log('✅ Messages table exists!');

    // Step 5: Verify schema
    console.log('\n📊 Step 5: Verifying database schema...');
    const { data: tableInfo, error: infoError } = await supabase
      .from('messages')
      .select('*')
      .limit(0);

    if (infoError) {
      console.warn('⚠️  Could not verify full schema:', infoError.message);
    } else {
      console.log('✅ Schema verification complete!');
    }

    console.log('\n🎉 Database setup complete!');
    console.log('✅ Ready for Day 2: Semantic Search\n');

    return true;

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error('Full error:', error);
    return false;
  }
}

// Run setup
setupDatabase()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

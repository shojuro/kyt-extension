#!/usr/bin/env node

/**
 * KYT CLI Memory Tool - Explicit Terminal Capture
 *
 * Usage:
 *   mem "Remember this command: ffmpeg -i video.mp4 output.mkv"
 *   mem --pipe "Save these test results" < test_output.txt
 *   npm test | mem --pipe "Test failure details"
 *
 * Philosophy: High-signal explicit capture (NO passive logging)
 * - User controls what gets remembered
 * - Maintains < 0.2 distance precision
 * - No noise pollution in vector database
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { stdin } from 'process';
import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';

// Configuration from .env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate config
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENAI_API_KEY) {
  console.error('❌ Missing required environment variables');
  console.error('   Required: SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY');
  console.error('   Check your .env file');
  process.exit(1);
}

// Initialize clients
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Generate embedding for content
 */
async function generateEmbedding(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float'
  });

  return response.data[0].embedding;
}

/**
 * Save memory to Supabase
 */
async function saveMemory(content, metadata = {}) {
  console.log('🧠 Capturing memory...');

  // Generate embedding
  const embedding = await generateEmbedding(content);

  // Prepare message data
  const messageData = {
    content: content,
    role: 'user', // CLI captures are always "user" initiated
    conversation_id: metadata.conversationId || null,
    model: 'cli',
    timestamp: Date.now(),
    message_id: `cli_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    embedding: embedding,
    source: 'cli', // Mark as CLI source
    synced_from_extension: new Date().toISOString()
  };

  // Insert to Supabase
  const { data, error } = await supabase
    .from('messages')
    .insert([messageData])
    .select();

  if (error) {
    throw new Error(`Supabase error: ${error.message}`);
  }

  return data[0];
}

/**
 * Read from stdin (for piping)
 * Uses a timeout to detect if stdin has data available
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let hasData = false;

    // Timeout: If no data received in 100ms, assume no pipe
    const timeout = setTimeout(() => {
      if (!hasData) {
        stdin.pause();
        resolve(null);
      }
    }, 100);

    stdin.setEncoding('utf8');

    stdin.on('data', (chunk) => {
      hasData = true;
      clearTimeout(timeout);
      data += chunk;
    });

    stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(data.trim() || null);
    });

    stdin.resume(); // Start reading
  });
}

/**
 * Main CLI function
 */
async function main() {
  const args = process.argv.slice(2);

  // No arguments
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  mem "your message to remember"');
    console.log('  mem --pipe "description" < file.txt');
    console.log('  npm test | mem --pipe "test results"');
    console.log('');
    console.log('Examples:');
    console.log('  mem "Remember: ffmpeg -i video.mp4 -vcodec copy output.mkv"');
    console.log('  mem "Stuck on RLS policy error with user authentication"');
    console.log('  npm test | mem --pipe "pytest failures in auth module"');
    process.exit(0);
  }

  let content;
  let description;

  // Handle --pipe flag
  if (args[0] === '--pipe') {
    description = args[1];
    if (!description) {
      console.error('❌ --pipe requires a description');
      console.error('   Example: mem --pipe "test results" < output.txt');
      process.exit(1);
    }

    // Read from stdin
    const pipeInput = await readStdin();

    if (!pipeInput) {
      console.error('❌ No input received from pipe');
      process.exit(1);
    }

    // Combine description + piped content
    content = `${description}\n\n${pipeInput}`;

  } else {
    // Regular message
    content = args.join(' ');
  }

  // Validate content length
  if (content.length < 3) {
    console.error('❌ Content too short (minimum 3 characters)');
    process.exit(1);
  }

  if (content.length > 8000) {
    console.warn('⚠️  Content very long, truncating to 8000 characters...');
    content = content.substring(0, 8000);
  }

  try {
    // Save to Supabase
    const saved = await saveMemory(content);

    console.log('✅ Memory captured successfully');
    console.log(`   ID: ${saved.message_id}`);
    console.log(`   Length: ${content.length} characters`);
    console.log(`   Source: CLI`);
    console.log('');
    console.log('💡 This memory is now searchable from ChatGPT and CLI');

  } catch (error) {
    console.error('❌ Failed to capture memory:', error.message);
    process.exit(1);
  }
}

// Run if called directly
// Resolve symlinks to get the real file path (for npm link compatibility)
const scriptPath = fileURLToPath(import.meta.url);
const argv1Real = realpathSync(process.argv[1]);

if (scriptPath === argv1Real) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

export { saveMemory, generateEmbedding };

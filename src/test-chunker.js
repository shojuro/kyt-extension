/**
 * Test script for conversation chunker
 *
 * Run with: node src/test-chunker.js
 */

import { messagesToTurnChunks, getChunkingStats } from './conversation-chunker.js';

// Sample messages for testing
const sampleMessages = [
  // Conversation 1: Python debugging (4 turns)
  {
    messageId: 'msg1',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'user',
    content: 'How do I fix a Python RLS bug in Supabase?',
    timestamp: 1700000000000,
  },
  {
    messageId: 'msg2',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'To fix RLS issues in Supabase with Python, you need to ensure your policies are correctly configured. Check the user_id column matches auth.uid().',
    timestamp: 1700000001000,
  },
  {
    messageId: 'msg3',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'user',
    content: 'What if the policy is correct but I still get errors?',
    timestamp: 1700000002000,
  },
  {
    messageId: 'msg4',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'Check your JWT token. Make sure you are passing the correct Authorization header with Bearer token.',
    timestamp: 1700000003000,
  },
  {
    messageId: 'msg5',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'user',
    content: 'How do I verify the JWT is valid?',
    timestamp: 1700000004000,
  },
  {
    messageId: 'msg6',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'You can decode the JWT using jwt.io to inspect the payload. Look for the sub claim which should match your user_id.',
    timestamp: 1700000005000,
  },
  {
    messageId: 'msg7',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'user',
    content: 'Thanks! That helped me find the issue.',
    timestamp: 1700000006000,
  },
  {
    messageId: 'msg8',
    conversationId: 'conv1',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'Great! Glad I could help with your Supabase RLS debugging.',
    timestamp: 1700000007000,
  },

  // Conversation 2: JavaScript API (3 turns)
  {
    messageId: 'msg9',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'user',
    content: 'How do I fetch data from an API in JavaScript?',
    timestamp: 1700001000000,
  },
  {
    messageId: 'msg10',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'Use the fetch() API: fetch("https://api.example.com/data").then(res => res.json()).then(data => console.log(data));',
    timestamp: 1700001001000,
  },
  {
    messageId: 'msg11',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'user',
    content: 'What about error handling?',
    timestamp: 1700001002000,
  },
  {
    messageId: 'msg12',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'Add .catch() at the end: .catch(error => console.error("Error:", error));',
    timestamp: 1700001003000,
  },
  {
    messageId: 'msg13',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'user',
    content: 'Can I use async/await instead?',
    timestamp: 1700001004000,
  },
  {
    messageId: 'msg14',
    conversationId: 'conv2',
    platform: 'chatgpt',
    role: 'assistant',
    content: 'Yes! async function getData() { try { const res = await fetch(url); const data = await res.json(); return data; } catch (error) { console.error(error); } }',
    timestamp: 1700001005000,
  },
];

console.log('🧪 Testing Conversation Chunker\n');

// Test 1: Basic chunking
console.log('Test 1: Basic chunking with sample data');
console.log('=' .repeat(60));

const testUserId = 'test-user-123';
const chunks = messagesToTurnChunks(sampleMessages, testUserId);

console.log(`\n📊 Results: ${chunks.length} chunks created`);

// Display each chunk
chunks.forEach((chunk, idx) => {
  console.log(`\nChunk ${idx + 1}:`);
  console.log(`  Turn range: ${chunk.turn_range}`);
  console.log(`  Turn count: ${chunk.turn_count}`);
  console.log(`  Conversation: ${chunk.conversation_id}`);
  console.log(`  Platform: ${chunk.platform}`);
  console.log(`  Speakers: ${chunk.speakers.join(', ')}`);
  console.log(`  Topics: ${chunk.topics.join(', ') || 'none'}`);
  console.log(`  Content preview: ${chunk.content.substring(0, 100)}...`);
  console.log(`  Timestamps: ${new Date(chunk.start_timestamp).toISOString()} → ${new Date(chunk.end_timestamp).toISOString()}`);
});

// Test 2: Statistics
console.log('\n\nTest 2: Chunking statistics');
console.log('=' .repeat(60));

const stats = getChunkingStats(chunks);
console.log('\nStatistics:');
console.log(`  Total chunks: ${stats.totalChunks}`);
console.log(`  Avg turns per chunk: ${stats.avgTurnsPerChunk}`);
console.log(`  Avg content length: ${stats.avgContentLength} chars`);
console.log(`  Platform distribution:`, stats.platformCounts);
console.log(`  Topic distribution:`, stats.topicCounts);

// Test 3: Edge cases
console.log('\n\nTest 3: Edge cases');
console.log('=' .repeat(60));

// Empty messages
const emptyChunks = messagesToTurnChunks([], testUserId);
console.log(`  Empty input: ${emptyChunks.length} chunks (expected 0)`);

// Single message
const singleMessage = [{
  messageId: 'msg-solo',
  conversationId: 'conv-solo',
  platform: 'chatgpt',
  role: 'user',
  content: 'Hello',
  timestamp: 1700000000000,
}];
const singleChunks = messagesToTurnChunks(singleMessage, testUserId);
console.log(`  Single message: ${singleChunks.length} chunks`);

// Incomplete turn (user without assistant)
const incompleteTurn = [
  {
    messageId: 'msg-incomplete-1',
    conversationId: 'conv-incomplete',
    platform: 'chatgpt',
    role: 'user',
    content: 'Question without answer',
    timestamp: 1700000000000,
  },
];
const incompleteChunks = messagesToTurnChunks(incompleteTurn, testUserId);
console.log(`  Incomplete turn: ${incompleteChunks.length} chunks`);

// Test 4: Overlap verification
console.log('\n\nTest 4: Overlap verification');
console.log('=' .repeat(60));

// Create 10 turns (should produce 3 chunks with windowSize=5, overlap=2)
const tenTurnMessages = [];
for (let i = 0; i < 10; i++) {
  tenTurnMessages.push({
    messageId: `user-${i}`,
    conversationId: 'conv-overlap-test',
    platform: 'chatgpt',
    role: 'user',
    content: `User message ${i + 1}`,
    timestamp: 1700000000000 + i * 1000,
  });
  tenTurnMessages.push({
    messageId: `assistant-${i}`,
    conversationId: 'conv-overlap-test',
    platform: 'chatgpt',
    role: 'assistant',
    content: `Assistant response ${i + 1}`,
    timestamp: 1700000000000 + i * 1000 + 500,
  });
}

const overlapChunks = messagesToTurnChunks(tenTurnMessages, testUserId);
console.log(`  10 turns → ${overlapChunks.length} chunks (expected 3 with windowSize=5, overlap=2)`);
overlapChunks.forEach((chunk, idx) => {
  console.log(`    Chunk ${idx + 1}: ${chunk.turn_range} (${chunk.turn_count} turns)`);
});

console.log('\n✅ All tests completed!\n');

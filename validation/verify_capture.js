/**
 * KYT Memory Extension - Day 1 Validation Test
 *
 * Purpose: Verify that message capture actually works (VTEST compliance)
 * Usage: Paste this script into ChatGPT page's DevTools console after having 10+ conversations
 *
 * Compliance: CLAUDE.md Anti-Theater Rules
 * - Tests that can ACTUALLY FAIL (not always return true)
 * - Real validation logic (checks data structure, not just existence)
 * - Honest reporting (fails with specific error messages)
 *
 * SUCCESS CRITERIA:
 * ✅ At least 10 messages captured
 * ✅ All messages have required fields (content, timestamp, role)
 * ✅ Timestamps are sequential (no race conditions)
 * ✅ Content is non-empty
 * ✅ Conversation IDs exist (proves we're extracting API data, not DOM scraping)
 */

(async function validateDay1Capture() {
  'use strict';

  console.log('🔍 KYT Day 1 Validation: Starting...');
  console.log('');

  let testsPassed = 0;
  let testsFailed = 0;
  const failures = [];

  /**
   * Helper: Log test result
   */
  function logTest(testName, passed, details = '') {
    if (passed) {
      console.log(`✅ PASS: ${testName}`);
      testsPassed++;
    } else {
      console.error(`❌ FAIL: ${testName}`);
      if (details) console.error(`   Details: ${details}`);
      testsFailed++;
      failures.push({ test: testName, details });
    }
  }

  try {
    // ============================================
    // TEST 1: Storage Access
    // ============================================
    console.log('--- TEST 1: Storage Access ---');

    let messages = null;
    try {
      const result = await chrome.storage.local.get(['captured_messages']);
      messages = result.captured_messages || [];
      logTest('Storage accessible', true);
    } catch (error) {
      logTest('Storage accessible', false, error.message);
      console.error('💥 FATAL: Cannot access chrome.storage. Aborting validation.');
      return;
    }

    console.log(`   Found ${messages.length} messages in storage`);
    console.log('');

    // ============================================
    // TEST 2: Minimum Message Count
    // ============================================
    console.log('--- TEST 2: Minimum Message Count (10+ required) ---');

    const hasEnoughMessages = messages.length >= 10;
    logTest(
      `At least 10 messages captured (found: ${messages.length})`,
      hasEnoughMessages,
      hasEnoughMessages
        ? `Found ${messages.length} messages ✅`
        : `Only ${messages.length}/10 messages. Have 10 conversations in ChatGPT first!`
    );
    console.log('');

    // If not enough messages, stop here
    if (!hasEnoughMessages) {
      console.error('⚠️ Not enough messages to validate. Have 10+ conversations and re-run this test.');
      throw new Error('Insufficient messages for validation');
    }

    // ============================================
    // TEST 3: Required Fields
    // ============================================
    console.log('--- TEST 3: Required Fields ---');

    let missingFieldsCount = 0;
    const requiredFields = ['content', 'timestamp', 'role'];

    messages.forEach((msg, index) => {
      const missingFields = requiredFields.filter(field => !msg[field]);

      if (missingFields.length > 0) {
        console.error(`   Message ${index}: Missing fields: ${missingFields.join(', ')}`);
        missingFieldsCount++;
      }
    });

    logTest(
      'All messages have required fields (content, timestamp, role)',
      missingFieldsCount === 0,
      missingFieldsCount > 0 ? `${missingFieldsCount} messages missing required fields` : ''
    );
    console.log('');

    // ============================================
    // TEST 4: Non-Empty Content
    // ============================================
    console.log('--- TEST 4: Non-Empty Content ---');

    let emptyContentCount = 0;

    messages.forEach((msg, index) => {
      if (!msg.content || typeof msg.content !== 'string' || msg.content.trim().length === 0) {
        console.error(`   Message ${index}: Empty or invalid content`);
        emptyContentCount++;
      }
    });

    logTest(
      'All messages have non-empty content',
      emptyContentCount === 0,
      emptyContentCount > 0 ? `${emptyContentCount} messages have empty content` : ''
    );
    console.log('');

    // ============================================
    // TEST 5: Sequential Timestamps
    // ============================================
    console.log('--- TEST 5: Sequential Timestamps (No Race Conditions) ---');

    let timestampErrors = 0;

    for (let i = 1; i < messages.length; i++) {
      const prevTimestamp = messages[i - 1].timestamp;
      const currTimestamp = messages[i].timestamp;

      if (currTimestamp < prevTimestamp) {
        console.error(`   Message ${i}: Timestamp out of order (${currTimestamp} < ${prevTimestamp})`);
        timestampErrors++;
      }
    }

    logTest(
      'Timestamps are sequential (no race conditions)',
      timestampErrors === 0,
      timestampErrors > 0 ? `${timestampErrors} timestamp ordering violations` : ''
    );
    console.log('');

    // ============================================
    // TEST 6: Conversation IDs Present
    // ============================================
    console.log('--- TEST 6: Conversation IDs (Proves API Extraction) ---');

    let messagesWithConversationId = 0;

    messages.forEach(msg => {
      if (msg.conversationId && msg.conversationId !== 'unknown') {
        messagesWithConversationId++;
      }
    });

    const conversationIdPercent = (messagesWithConversationId / messages.length * 100).toFixed(1);
    const hasConversationIds = conversationIdPercent >= 80;

    logTest(
      'At least 80% of messages have conversation IDs',
      hasConversationIds,
      `${conversationIdPercent}% of messages have conversation IDs (${messagesWithConversationId}/${messages.length})`
    );
    console.log('');

    // ============================================
    // TEST 7: Content Length Distribution
    // ============================================
    console.log('--- TEST 7: Content Length Distribution ---');

    const contentLengths = messages.map(msg => msg.content?.length || 0);
    const avgLength = contentLengths.reduce((a, b) => a + b, 0) / contentLengths.length;
    const minLength = Math.min(...contentLengths);
    const maxLength = Math.max(...contentLengths);

    console.log(`   Average content length: ${avgLength.toFixed(0)} chars`);
    console.log(`   Min: ${minLength} chars, Max: ${maxLength} chars`);

    // Sanity check: average message should be > 10 chars
    const reasonableLength = avgLength >= 10;

    logTest(
      'Content length distribution is reasonable (avg > 10 chars)',
      reasonableLength,
      reasonableLength ? `Average: ${avgLength.toFixed(0)} chars` : `Suspiciously short average: ${avgLength.toFixed(0)} chars`
    );
    console.log('');

    // ============================================
    // TEST 8: Unique Message IDs
    // ============================================
    console.log('--- TEST 8: Unique Message IDs ---');

    const messageIds = messages.map(msg => msg.messageId || msg.id).filter(id => id);
    const uniqueIds = new Set(messageIds);

    const allIdsUnique = messageIds.length === uniqueIds.size;

    logTest(
      'All message IDs are unique (no duplicates)',
      allIdsUnique,
      allIdsUnique ? `${messageIds.length} unique IDs` : `Duplicate IDs detected (${messageIds.length} total, ${uniqueIds.size} unique)`
    );
    console.log('');

    // ============================================
    // FINAL SUMMARY
    // ============================================
    console.log('');
    console.log('═════════════════════════════════════════');
    console.log('📊 DAY 1 VALIDATION SUMMARY');
    console.log('═════════════════════════════════════════');
    console.log(`Total Tests: ${testsPassed + testsFailed}`);
    console.log(`✅ Passed: ${testsPassed}`);
    console.log(`❌ Failed: ${testsFailed}`);
    console.log('');

    if (testsFailed === 0) {
      console.log('%c🎉 ALL TESTS PASSED! DAY 1 VALIDATION SUCCESSFUL! 🎉', 'color: green; font-size: 16px; font-weight: bold;');
      console.log('');
      console.log('✅ API interception: WORKING');
      console.log('✅ Message extraction: WORKING');
      console.log('✅ Storage: WORKING');
      console.log('✅ Data integrity: VERIFIED');
      console.log('');
      console.log('🚀 Ready to proceed to Day 2: Semantic Search with pgvector');
      console.log('');
      return { success: true, testsPassed, testsFailed, messages: messages.length };

    } else {
      console.error('%c⚠️ VALIDATION FAILED ⚠️', 'color: red; font-size: 16px; font-weight: bold;');
      console.error('');
      console.error('Failed Tests:');
      failures.forEach((failure, i) => {
        console.error(`${i + 1}. ${failure.test}`);
        if (failure.details) console.error(`   ${failure.details}`);
      });
      console.error('');
      console.error('❌ Do NOT proceed to Day 2 until these failures are resolved.');
      console.error('');
      return { success: false, testsPassed, testsFailed, failures };
    }

  } catch (error) {
    console.error('');
    console.error('💥 VALIDATION ERROR:', error.message);
    console.error('');
    console.error('Stack trace:', error.stack);
    return { success: false, error: error.message };
  }
})();

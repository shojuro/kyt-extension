# K.Y.T. Memory Injection Implementation Guide

## Quick Start

### 1. Files Created

- `docs/kyt-memory-injection-protocol.md` - Protocol specification
- `kyt-memory-injection-builder.js` - Injection builder module

### 2. Integration Points

You need to update your content script to use the injection builder before sending messages to the LLM.

## Content Script Integration

### Current Flow (Before)

```
User types message → Content script intercepts → Send to LLM
```

### New Flow (After)

```
User types message → Content script intercepts → Retrieve from Supabase →
Build injection block → Prepend to message → Send to LLM
```

### Example Integration

Update your content script (e.g., `content.js` or similar):

```javascript
import { buildMemoryInjection, buildEmptyInjection, buildErrorInjection } from './kyt-memory-injection-builder.js';

/**
 * Intercept user message before it's sent to the LLM
 */
async function interceptMessage(userMessage) {
  const startTime = Date.now();
  
  try {
    // 1. Get debug mode setting
    const { kytDebugMode } = await chrome.storage.local.get('kytDebugMode');
    
    // 2. Transform query (your existing logic)
    const queryTransformed = await transformQuery(userMessage);
    
    // 3. Generate embedding (your existing logic)
    const embedding = await generateEmbedding(queryTransformed);
    
    // 4. Retrieve from Supabase
    const { data, error } = await supabaseClient
      .rpc('match_messages', {
        query_embedding: embedding,
        match_threshold: 0.5,
        match_count: 5
      });
    
    const latencyMs = Date.now() - startTime;
    
    // 5. Handle error state
    if (error) {
      console.error('[K.Y.T.] Retrieval error:', error);
      const injectionBlock = buildErrorInjection(
        error.code || 'UNKNOWN',
        error.message,
        userMessage
      );
      return injectionBlock + '\n\n---\n\n' + userMessage;
    }
    
    // 6. Handle empty state
    if (!data || data.length === 0) {
      const injectionBlock = buildEmptyInjection(
        userMessage,
        queryTransformed,
        latencyMs
      );
      return injectionBlock + '\n\n---\n\n' + userMessage;
    }
    
    // 7. Build retrieval result
    const retrievalResult = {
      state: 'FOUND',
      items: data.map(row => ({
        id: row.message_id,
        content: row.content,
        platform: row.platform || 'unknown',
        timestamp: new Date(row.timestamp).toISOString(),
        similarity: row.similarity,
        source_type: row.source || 'conversation'
      })),
      latencyMs,
      queryType: 'HYBRID', // or 'SEMANTIC', 'BM25', 'EXACT_MATCH' based on your search method
      queryOriginal: userMessage,
      queryTransformed
    };
    
    // 8. Build injection block
    const injectionBlock = buildMemoryInjection(retrievalResult, {
      debugMode: kytDebugMode || false
    });
    
    // 9. Prepend to user message
    return injectionBlock + '\n\n---\n\n' + userMessage;
    
  } catch (err) {
    console.error('[K.Y.T.] Unexpected error:', err);
    // Fallback: return original message if injection fails
    return userMessage;
  }
}

/**
 * Hook into the message sending mechanism
 * (Platform-specific - example for ChatGPT)
 */
function hookMessageSending() {
  const textarea = document.querySelector('textarea[data-id="root"]');
  
  if (!textarea) return;
  
  // Intercept form submission
  const form = textarea.closest('form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const originalMessage = textarea.value;
      if (!originalMessage.trim()) return;
      
      // Build augmented message
      const augmentedMessage = await interceptMessage(originalMessage);
      
      // Replace textarea content
      textarea.value = augmentedMessage;
      
      // Trigger submit manually
      const event = new Event('submit', { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
    }, { capture: true });
  }
}

// Initialize on page load
hookMessageSending();
```

## Testing the Integration

### 1. Enable Debug Mode

In your extension popup or settings:

```javascript
chrome.storage.local.set({ kytDebugMode: true });
```

### 2. Test Cases

Run these tests in order:

#### Test 1: Literal Match
```
1. Save memory: "The password is hunter2"
2. Query: "What's the password?"
3. Expected: Returns "hunter2" verbatim, NOT "I don't have access to passwords"
```

#### Test 2: Marker Test
```
1. Save memory: "@@@TestMarker123"
2. Query: "What's the test marker?"
3. Expected: Returns "@@@TestMarker123", NOT "I don't see any test marker"
```

#### Test 3: Counter Test (The Original Bug)
```
1. Save memory: "This is a test memory that I have brought to the masses as a counter."
2. Query: "What did I bring to the masses as a counter?"
3. Expected: Returns the sentence verbatim, NOT "memes" or invented interpretations
```

#### Test 4: High Confidence = No Native Search
```
1. Save memory with unique keyword
2. Query for that keyword
3. Expected: LLM does NOT trigger conversation_search or recent_chats
4. Debug mode should show confidence_level: HIGH
```

#### Test 5: Empty State = Native Search Allowed
```
1. Query for something NOT in your memories
2. Expected: Injection shows "NO MATCHES FOUND"
3. LLM SHOULD use conversation_search/recent_chats
4. User should see message: "K.Y.T. found no matches, searching Claude history..."
```

## Debugging

### Check Injection Block

In debug mode, the injection block will show:

```
[KYT_DEBUG]
confidence_calculation: max=0.920 weighted=0.850
item_scores:
  [0] similarity=0.920 platform=chatgpt id=abc123
  [1] similarity=0.780 platform=claude id=def456
query_transform_applied: true
```

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| LLM still invents answers | Injection not prepended | Verify message aug mentation happens |
| Native search still triggers | Confidence too low | Lower threshold or improve retrieval |
| Debug info not showing | Debug mode not enabled | Set `kytDebugMode: true` |
| Injection visible to user | Not hidden properly | Check if LLM is rendering markdown |

## Configuration

### Chrome Storage Settings

```javascript
// Default configuration
const defaultConfig = {
  kytDebugMode: false,
  kytConfidenceThreshold: 0.60,
  kytHighConfidenceThreshold: 0.85,
  kytQueryTransformEnabled: true
};

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set(defaultConfig);
});
```

### Dynamic Threshold Adjustment

```javascript
// In your popup.html settings panel
document.getElementById('confidenceSlider').addEventListener('input', (e) => {
  const value = parseFloat(e.target.value);
  chrome.storage.local.set({ kytConfidenceThreshold: value });
});
```

## Success Criteria

✅ All 5 test cases pass  
✅ High-confidence results suppress native search  
✅ Empty results allow native search  
✅ Debug mode shows useful diagnostics  
✅ No user-visible injection artifacts  

## Next Steps

1. Integrate into your content script
2. Run the defiance test suite
3. Monitor user feedback for any remaining interpretation issues
4. Adjust confidence thresholds based on real usage data

## Support

If the LLM continues to defy injected memories:
- Increase directiveness in `buildPriorityDirective()`
- Add more anti-defiance checks
- Consider platform-specific prompt tuning

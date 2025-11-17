# Console Log Diagnostic Guide

## Problem: `window.KYT_Deduplicator` is undefined

This means the **old version** of inject.js is still running in your browser.

---

## CRITICAL: Hard Reload Required

Chrome **caches** extension scripts aggressively. You need to **hard reload** both the extension AND the page.

### Step 1: Clear Extension Cache (REQUIRED)

```bash
1. Open chrome://extensions
2. Find "KYT Memory - Multi-Platform"
3. Click "Remove" button
4. Click "Load unpacked" button
5. Select the extension directory again
```

**Why**: This clears the service worker cache completely

---

### Step 2: Hard Reload ChatGPT (REQUIRED)

```bash
1. Open https://chatgpt.com
2. Press Ctrl+Shift+Delete (open Clear Browsing Data)
3. Select "Cached images and files"
4. Click "Clear data"
5. Close and reopen ChatGPT tab
6. Press Ctrl+Shift+R (hard refresh)
```

**Why**: This clears the page context cache

---

### Step 3: Check Expected Console Logs

After hard reload, you should see this **exact sequence** in console:

```
🚀 KYT ChatGPT Content: Initializing...
✅ KYT ChatGPT Content: inject.js loaded into page context
✅ KYT ChatGPT Content: Listening for messages from page context
🚀 KYT ChatGPT Inject: Initializing in page context...
🔄 KYT ChatGPT: Deduplication layer initialized in page context  ← THIS IS THE KEY LOG
✅ KYT ChatGPT: Using fetch interception only (recommended)
💡 To enable voice capture, set KYT_CONFIG.enableVoiceCapture = true
✅ KYT ChatGPT: Fetch override installed in PAGE CONTEXT
ℹ️ KYT ChatGPT: DOM observer DISABLED (fetch-only mode)
```

**✅ SUCCESS**: If you see "🔄 KYT ChatGPT: Deduplication layer initialized"
**❌ FAILURE**: If you DON'T see that log, the old version is still cached

---

### Step 4: Verify Deduplicator Exists

**In console, type**:
```javascript
window.KYT_Deduplicator
```

**Expected Output**:
```javascript
MessageDeduplicator {
  recentMessages: Map(0),
  dedupeWindow: 5000,
  cleanupInterval: 2,
  stats: { totalAttempts: 0, captured: 0, ... }
}
```

**✅ SUCCESS**: Object returned
**❌ FAILURE**: `undefined` → Old version still cached

---

### Step 5: Check inject.js Version in DevTools

```bash
1. In DevTools, go to Sources tab
2. Navigate to: Page → chatgpt.com → (no domain) → platforms/chatgpt/inject.js
3. Press Ctrl+F and search for: "Deduplication layer initialized"
4. Check if line ~130 has: console.log('🔄 KYT ChatGPT: Deduplication layer initialized in page context');
```

**✅ SUCCESS**: Line exists in loaded file
**❌ FAILURE**: Line doesn't exist → Old version cached

---

## Alternative: Incognito Window Test

If hard reload doesn't work, try **incognito mode**:

```bash
1. Open chrome://extensions
2. Enable "Allow in incognito" for KYT extension
3. Open incognito window (Ctrl+Shift+N)
4. Navigate to https://chatgpt.com
5. Check console for "Deduplication layer initialized" log
6. Test: window.KYT_Deduplicator.getStats()
```

Incognito mode has **no cache**, so it will definitely load the new version.

---

## If Still Failing

If you've done **all of the above** and still see `undefined`:

1. **Check git commit**: Run `git log --oneline -1`
   - Should show: `15272fa fix: Move deduplication layer to page context`

2. **Verify file contents**: Run `grep -n "Deduplication layer initialized" platforms/chatgpt/inject.js`
   - Should show line ~130 with the log

3. **Check service worker errors**:
   - Go to chrome://extensions
   - Click "Inspect views: service worker" under KYT extension
   - Check for errors in the service worker console

4. **Share debug info**:
   - Git commit hash
   - Full console logs from ChatGPT
   - Service worker console logs
   - Chrome version

---

## TL;DR - Quick Fix

```bash
# 1. Remove and re-add extension
chrome://extensions → Remove → Load unpacked

# 2. Hard reload ChatGPT
Ctrl+Shift+Delete → Clear cache → Close tab → Reopen → Ctrl+Shift+R

# 3. Check console for:
"🔄 KYT ChatGPT: Deduplication layer initialized in page context"

# 4. Test:
window.KYT_Deduplicator.getStats()

# Should return object, not undefined
```

---

**Bottom Line**: Chrome is serving the **old cached version**. You need to completely remove and re-add the extension to clear the cache.

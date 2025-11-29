# Security Audit Report

## Executive Summary
A comprehensive security review of the K.Y.T. Memory Extension codebase was conducted. The review identified **CRITICAL** vulnerabilities in the ChatGPT content script that expose the extension's privileged APIs and storage (including API keys) to the web page context. These vulnerabilities allow any script running on `chatgpt.com` (including potential XSS payloads) to steal credentials, inject fake data, or redirect user data.

## Critical Vulnerabilities

### 1. Unrestricted Runtime Message Bridge (`platforms/chatgpt/content.js`)
**Severity:** Critical
**Location:** `platforms/chatgpt/content.js` (Lines 208-230)
**Description:**
The content script sets up an event listener for `KYT_TEST_RUNTIME_MESSAGE` that blindly forwards any message from the page context (MAIN world) to the extension's background script via `chrome.runtime.sendMessage`.
**Impact:**
An attacker can invoke any background script action, including:
- `SET_API_CONFIG`: Overwrite the user's API keys with the attacker's keys, causing the user's chat history to be synced to the attacker's database.
- `SAVE_MESSAGE`: Inject fake memories into the user's database.
- `SYNC_TO_SUPABASE`: Force a sync operation.

**Code Snippet:**
```javascript
window.addEventListener('KYT_TEST_RUNTIME_MESSAGE', async function (event) {
  const { requestId, message } = event.detail;
  // ...
    chrome.runtime.sendMessage(message, (response) => {
      // ...
    });
  // ...
});
```

### 2. Exposed Storage Access (`platforms/chatgpt/content.js`)
**Severity:** Critical
**Location:** `platforms/chatgpt/content.js` (Lines 160-205)
**Description:**
The content script exposes `chrome.storage.local` read and write access to the page context via `KYT_TEST_STORAGE_GET` and `KYT_TEST_STORAGE_SET` event listeners.
**Impact:**
An attacker can read the `api_config` object from storage, which contains the user's **OpenAI API Key** and **Supabase Service Role Key**. This leads to full compromise of the user's connected services.

**Code Snippet:**
```javascript
window.addEventListener('KYT_TEST_STORAGE_GET', async function (event) {
  const { requestId, keys } = event.detail;
  // ...
    chrome.storage.local.get(keys, (result) => {
      // ...
    });
  // ...
});
```

## High Severity Issues

### 3. Unprotected Configuration Update (`background.js`)
**Severity:** High
**Location:** `background.js` (Lines 1193-1206)
**Description:**
The `SET_API_CONFIG` message handler in `background.js` does not verify the source of the message. While `chrome.runtime.onMessage` usually handles messages from content scripts or popup, combined with Vulnerability #1, this becomes easily exploitable from the web page. Even without #1, a compromised content script could change the config.
**Recommendation:**
Verify `sender.id` and ensure configuration changes only come from the extension's popup or options page (e.g., check `sender.url`).

## Low Severity Issues

### 4. Potential ReDoS in Injection Stripping
**Severity:** Low
**Location:** `platforms/chatgpt/inject.js` and `platforms/claude/inject.js`
**Description:**
The regex used to strip injection blocks (`/={3,}[\s\S]*?K\.Y\.T\.[\s\S]*?(?:={3,}|$)/g`) involves `[\s\S]*?` inside a capturing group with potential backtracking. While likely safe due to the specific structure, it should be reviewed or replaced with a non-regex parser if possible.

### 5. Ignored Verification Scripts
**Severity:** Info
**Location:** `verify_*.js` (e.g., `verify_chat_turns_schema.js`)
**Description:**
Several verification scripts are present in the directory but ignored by `.gitignore`. If these files contain hardcoded secrets for testing and are accidentally committed or shared, they pose a risk.
**Recommendation:**
Ensure these files do not contain real production secrets, or use environment variables.

## Recommendations

1.  **IMMEDIATE ACTION**: Remove the "Test API Bridge" section from `platforms/chatgpt/content.js` (lines 158-230). These listeners should NOT be present in production code.
2.  **Restrict Message Handling**: In `background.js`, modify sensitive message handlers (`SET_API_CONFIG`, `GET_STATS`) to verify that the sender is the extension's popup or options page, not a content script.
3.  **Sanitize Inputs**: Ensure all data received from the page context (via `inject.js`) is strictly validated before use.
4.  **Review Content Security Policy**: Ensure the extension's CSP is strict.

## Conclusion
The codebase contains critical security flaws that must be addressed immediately before any deployment. The exposure of privileged extension APIs to the web page context negates the security model of the browser extension architecture.

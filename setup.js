/**
 * setup.js — Auth + developer config for KYT Memory Extension.
 *
 * Handles three views:
 *   1. Login form (email/password + Google OAuth)
 *   2. Sign-up form
 *   3. Signed-in state (shows email + sign out)
 *
 * Developer Mode (collapsed at bottom) preserves the legacy 6-field
 * API key form for self-hosters.
 */

import { signIn, signUp, signOut, getSession, AUTH_SESSION_KEY } from './src/auth/auth-service.js';
import { signInWithGoogle } from './src/auth/google-oauth.js';
import { checkAndMigrateLegacyData } from './src/auth/migration.js';

// ─── DOM refs ────────────────────────────────────────────────

const loginView = document.getElementById('loginView');
const signUpView = document.getElementById('signUpView');
const signedInView = document.getElementById('signedInView');
const signedInEmail = document.getElementById('signedInEmail');
const statusMsg = document.getElementById('statusMsg');
const migrationPrompt = document.getElementById('migrationPrompt');

// Login form
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginBtn');
const loginEmail = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');

// Sign-up form
const signUpForm = document.getElementById('signUpForm');
const signUpBtn = document.getElementById('signUpBtn');

// Toggles
const showSignUpLink = document.getElementById('showSignUp');
const showLoginLink = document.getElementById('showLogin');

// Buttons
const googleBtn = document.getElementById('googleBtn');
const signOutBtn = document.getElementById('signOutBtn');
const devSaveBtn = document.getElementById('devSaveBtn');

// ─── View switching ──────────────────────────────────────────

function showView(view) {
  loginView.classList.add('hidden');
  signUpView.classList.add('hidden');
  signedInView.classList.add('hidden');
  view.classList.remove('hidden');
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status ' + type;
  if (type === 'success') {
    setTimeout(() => { statusMsg.className = 'status'; }, 5000);
  }
}

function clearStatus() {
  statusMsg.className = 'status';
}

// ─── Auth flow: on successful sign-in ────────────────────────

async function onAuthSuccess(session) {
  signedInEmail.textContent = session.user?.email || 'Authenticated';
  showView(signedInView);
  showStatus('Signed in successfully!', 'success');

  // Check for legacy data migration
  try {
    const result = await chrome.storage.local.get(['api_config']);
    const legacyUserId = result.api_config?.userId;

    if (legacyUserId && legacyUserId !== session.user?.id) {
      migrationPrompt.style.display = 'block';
      migrationPrompt.innerHTML =
        `You have existing data under a previous ID. ` +
        `<button id="migrateBtn" style="margin-left:8px;padding:4px 10px;border:1px solid #0c5460;background:white;border-radius:4px;cursor:pointer;">Link existing data</button>` +
        `<button id="skipMigrateBtn" style="margin-left:4px;padding:4px 10px;border:1px solid #ccc;background:white;border-radius:4px;cursor:pointer;">Skip</button>`;

      document.getElementById('migrateBtn').addEventListener('click', async () => {
        try {
          migrationPrompt.textContent = 'Migrating...';
          await checkAndMigrateLegacyData(session.user.id);
          migrationPrompt.textContent = 'Data linked successfully!';
          migrationPrompt.className = 'status success';
        } catch (err) {
          migrationPrompt.textContent = 'Migration failed: ' + err.message;
          migrationPrompt.className = 'status error';
        }
      });

      document.getElementById('skipMigrateBtn').addEventListener('click', () => {
        migrationPrompt.style.display = 'none';
      });
    }
  } catch (err) {
    console.warn('Migration check failed:', err);
  }
}

// ─── Event: Login form submit ────────────────────────────────

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearStatus();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in...';

  try {
    const session = await signIn(loginEmail.value.trim(), loginPassword.value);
    await onAuthSuccess(session);
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

// ─── Event: Sign-up form submit ──────────────────────────────

signUpForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearStatus();
  signUpBtn.disabled = true;
  signUpBtn.textContent = 'Creating account...';

  try {
    const result = await signUp(
      document.getElementById('signUpEmail').value.trim(),
      document.getElementById('signUpPassword').value,
    );

    if (result.confirmation_required) {
      showStatus('Check your email to confirm your account, then sign in.', 'info');
      showView(loginView);
    } else {
      await onAuthSuccess(result);
    }
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    signUpBtn.disabled = false;
    signUpBtn.textContent = 'Create Account';
  }
});

// ─── Event: Google OAuth ─────────────────────────────────────

googleBtn.addEventListener('click', async () => {
  clearStatus();
  googleBtn.disabled = true;
  googleBtn.textContent = 'Opening Google...';

  try {
    const session = await signInWithGoogle();
    await onAuthSuccess(session);
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    googleBtn.disabled = false;
    googleBtn.innerHTML =
      `<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 010-9.18l-7.98-6.19a24.01 24.01 0 000 21.56l7.98-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg> Continue with Google`;
  }
});

// ─── Event: Sign out ─────────────────────────────────────────

signOutBtn.addEventListener('click', async () => {
  await signOut();
  migrationPrompt.style.display = 'none';
  showView(loginView);
  showStatus('Signed out.', 'success');
});

// ─── Event: View toggles ────────────────────────────────────

showSignUpLink.addEventListener('click', () => {
  clearStatus();
  showView(signUpView);
});

showLoginLink.addEventListener('click', () => {
  clearStatus();
  showView(loginView);
});

// ─── Developer mode: legacy key save ─────────────────────────

devSaveBtn.addEventListener('click', async () => {
  const config = {
    supabaseUrl: document.getElementById('supabaseUrl').value.trim(),
    supabaseKey: document.getElementById('supabaseKey').value.trim(),
    openaiKey: document.getElementById('openaiKey').value.trim(),
    huggingfaceKey: document.getElementById('huggingfaceKey').value.trim(),
    jinaKey: document.getElementById('jinaKey').value.trim() || null,
    userId: document.getElementById('userId').value.trim() || null,
    disableQueryTransformation: document.getElementById('disableQueryTransformation').checked,
  };

  try {
    await chrome.storage.local.set({ api_config: config });
    showStatus('Developer config saved.', 'success');
  } catch (err) {
    showStatus('Error saving config: ' + err.message, 'error');
  }
});

// ─── On load: check existing session ─────────────────────────

async function init() {
  try {
    const session = await getSession();
    if (session) {
      signedInEmail.textContent = session.user?.email || 'Authenticated';
      showView(signedInView);
    } else {
      showView(loginView);
    }
  } catch (err) {
    showView(loginView);
  }

  // Pre-fill developer mode fields if api_config exists
  try {
    const result = await chrome.storage.local.get(['api_config']);
    const config = result.api_config;
    if (config) {
      if (config.supabaseUrl) document.getElementById('supabaseUrl').value = config.supabaseUrl;
      if (config.supabaseKey) document.getElementById('supabaseKey').value = config.supabaseKey;
      if (config.openaiKey) document.getElementById('openaiKey').value = config.openaiKey;
      if (config.huggingfaceKey) document.getElementById('huggingfaceKey').value = config.huggingfaceKey;
      if (config.jinaKey) document.getElementById('jinaKey').value = config.jinaKey;
      if (config.userId) document.getElementById('userId').value = config.userId;
      document.getElementById('disableQueryTransformation').checked =
        config.disableQueryTransformation !== undefined ? config.disableQueryTransformation : true;
    }
  } catch (err) {
    // Non-critical
  }
}

init();

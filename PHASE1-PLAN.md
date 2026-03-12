# K.Y.T. Android App — Phase 1 Plan: Build & Authenticate

**Branch**: `feature/keyboard`
**Worktree**: `/home/penguinzyue/kyt-wt-keyboard`
**Date**: 2026-03-13

---

## Current State
- 13 Kotlin files exist with real logic (1,838 lines total)
- Voice proxy (TypeScript, Fly.io) exists but not deployed
- DB migration written but not applied to production
- Nothing committed on `feature/keyboard`
- NOT buildable — skeleton files, dependency resolution untested

---

## To-Do List

### 1. Housekeeping (Commit & Migrate)
- [ ] 1.1 Apply migration to production — run `20260301000000_add_mobile_platforms.sql` against Supabase
- [ ] 1.2 Fill in `gradle.properties` with real values (KYT_SUPABASE_URL, KYT_SUPABASE_ANON_KEY, KYT_VOICE_PROXY_URL)
- [ ] 1.3 Commit all existing work on `feature/keyboard`

### 2. Gradle / Build Resolution
- [ ] 2.1 Open project in Android Studio, sync Gradle
- [ ] 2.2 Resolve dependency versions — Compose BOM, Supabase Kotlin SDK, Material3, coroutines
- [ ] 2.3 Fix compile errors in the 13 Kotlin files (written without IDE validation)
- [ ] 2.4 Verify compileSdk=34, minSdk=26, targetSdk=34 match SDK install
- [ ] 2.5 Successful `./gradlew assembleDebug` — APK builds clean

### 3. Auth Flow (Supabase OAuth)
- [ ] 3.1 Configure Supabase Google OAuth redirect URI for Android deep link (`com.kyt.android://callback`)
- [ ] 3.2 Wire AuthManager.kt — token storage in EncryptedSharedPreferences, refresh logic
- [ ] 3.3 Wire LoginScreen.kt — Compose UI, launches OAuth browser intent, handles redirect
- [ ] 3.4 Test: Launch → Login → Google OAuth → token stored → redirect back
- [ ] 3.5 Test: Token refresh — force-expire, verify silent refresh
- [ ] 3.6 Test: Logout flow — clear tokens, return to login

### 4. Supabase Connectivity
- [ ] 4.1 Wire SupabaseClient.kt — verify authenticated requests reach Supabase
- [ ] 4.2 Test: Insert test chat_turn with platform='mobile'
- [ ] 4.3 Test: Query chat_turns — verify RLS passes (user_id matches JWT)
- [ ] 4.4 Wire OfflineQueue.kt — queue when offline, flush on connectivity

### 5. Basic UI Shell
- [ ] 5.1 KytApplication.kt — entry point initializes Supabase client + auth manager
- [ ] 5.2 Navigation: Login → Main screen (placeholder) with memory mode indicator
- [ ] 5.3 MemoryModeManager.kt — read/write mode to SharedPreferences, badge in UI
- [ ] 5.4 Settings screen stub — memory mode toggle, logout button

### 6. Deploy to Emulator
- [ ] 6.1 `./gradlew installDebug` to running emulator
- [ ] 6.2 Smoke test: install → login → main screen → check Supabase for auth record
- [ ] 6.3 Test on API 26 (min) and API 34 (target) emulator images

### 7. Commit Phase 1 Complete
- [ ] 7.1 Commit buildable, authenticating app
- [ ] 7.2 Tag: v0.1.0-alpha — "App builds, authenticates, connects to Supabase"

---

## Phase 1 Exit Criteria
- APK builds without errors
- Google OAuth login works end-to-end
- Authenticated Supabase read/write from the app
- Offline queue stores messages locally when disconnected
- Memory mode toggle persists across app restarts
- Runs on emulator (API 26 and 34)

## What Phase 1 Does NOT Include
- Keyboard IME (Phase 2)
- Voice capture/transcription (Phase 2)
- Share Sheet (Phase 3)
- Context injection into other apps (Phase 4)

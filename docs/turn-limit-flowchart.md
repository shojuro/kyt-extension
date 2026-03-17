# K.Y.T. Turn Limit Flow — From Limit Hit to Resolution

## Architecture Summary

The turn limiter gates **retrieval** (context injection), not **capture** (message saving).
All messages always sync, embed, and extract entities regardless of limit status.
The user experiences "memory paused" — K.Y.T. stops recalling, not recording.

---

## FLOWCHART

```
╔══════════════════════════════════════════════════════════════════════╗
║                     USER SENDS MESSAGE #20                         ║
║                   (on ChatGPT / Claude / Gemini)                   ║
╚══════════════════════════╦═══════════════════════════════════════════╝
                           ║
       ════════════════════╩════════════════════
       ║  CAPTURE PATH (always runs)           ║
       ═════════════════════════════════════════
                           │
                           ▼
              ┌────────────────────────┐
              │  Platform content.js   │
              │  intercepts message    │
              │  (XHR/fetch override)  │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  queue-manager.js      │
              │  capture(messageData)  │
              │  → sendMessage:        │
              │    SAVE_MESSAGE        │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  message-handlers.js   │
              │  case 'SAVE_MESSAGE'   │
              │                        │
              │  ✅ Memory mode check  │
              │  ✅ saveMessage()      │  ◄── Message saved to chrome.storage.local
              │  ✅ incrementTurnCount │  ◄── kyt_daily_turns.count = 20
              │  ✅ scheduleDebouncedSync│ ◄── Queues Supabase sync
              │                        │
              │  Returns:              │
              │  { success: true }     │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  browser-sync.js       │
              │  Debounced sync fires  │
              │                        │
              │  ✅ Upserts to         │
              │    chat_turns table    │
              │  ✅ Generates embedding│  ◄── HuggingFace/Qwen3 1024d
              │  ✅ Entity extraction  │  ◄── Haiku 4.5 via backfill alarm
              │  ✅ Gravity scoring    │  ◄── GPT-4.1-mini via backfill alarm
              │                        │
              │  Message is FULLY      │
              │  indexed in the graph  │
              └────────────────────────┘

    ════════════════════════════════════════════
    ║  MESSAGE #20 IS SAVED. GRAPH ENRICHED.  ║
    ║  The user's data is growing silently.   ║
    ════════════════════════════════════════════

                           │
                           │  (Meanwhile, on the SAME message or any after...)
                           │
       ════════════════════╩════════════════════
       ║  RETRIEVAL PATH (gated)               ║
       ═════════════════════════════════════════
                           │
                           ▼
              ┌────────────────────────┐
              │  Platform inject.js    │
              │  User message detected │
              │  → sendMessage:        │
              │    GET_CONTEXT         │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  message-handlers.js   │
              │  case 'GET_CONTEXT'    │
              │  → handleGetContext-   │
              │    Async()             │
              └───────────┬────────────┘
                          │
                          ▼
              ┌────────────────────────┐
              │  GATE 1: Memory Mode  │
              │  getMemoryMode()      │
              │                       │
              │  full → continue      │
              │  clean_room → block   │
              │  incognito → block    │
              └───────────┬────────────┘
                          │ (mode = 'full')
                          ▼
              ┌────────────────────────┐
              │  GATE 2: Turn Limit   │
              │  checkTurnLimit()     │
              │                       │
              │  Reads:               │
              │   kyt_daily_turns     │
              │   { date, count: 20 } │
              │   user_tier = 'free'  │
              │   limit = 20          │
              │                       │
              │  20 < 20 = FALSE      │
              │  allowed = false      │
              └───────┬───────┬────────┘
                      │       │
                      │       │
         ┌────────────┘       └────────────┐
         ▼                                 ▼
┌─────────────────────┐     ┌──────────────────────────┐
│  RETURN EMPTY       │     │  NOTIFY ACTIVE TAB       │
│  CONTEXT            │     │                          │
│                     │     │  chrome.tabs.sendMessage  │
│  { success: true,   │     │  {                       │
│    items: [],       │     │    type:                  │
│    formattedContext: │     │     'KYT_TURN_LIMIT_     │
│      null,          │     │      REACHED',           │
│    turnLimitReached: │     │    used: 20,             │
│      true,          │     │    limit: 20,            │
│    used: 20,        │     │    tier: 'free'          │
│    limit: 20,       │     │  }                       │
│    tier: 'free'     │     │                          │
│  }                  │     │                          │
└─────────┬───────────┘     └──────────┬───────────────┘
          │                            │
          ▼                            ▼
┌─────────────────────┐     ┌──────────────────────────┐
│  Written to         │     │  upgrade-banner.js       │
│  chrome.storage     │     │  (content script)        │
│  kyt_ctx_{reqId}    │     │                          │
│                     │     │  Receives message via    │
│  Bridge picks up    │     │  chrome.runtime.         │
│  via onChanged      │     │  onMessage listener      │
│  → sees empty items │     │                          │
│  → NO injection     │     │  Checks:                 │
│    into prompt      │     │  ✓ !bannerShown          │
│                     │     │  ✓ !isDismissed()        │
│  LLM responds       │     │    (sessionStorage)      │
│  WITHOUT K.Y.T.     │     │                          │
│  memory context     │     │  → createBanner()        │
└─────────────────────┘     └──────────┬───────────────┘
                                       │
                                       ▼
              ┌────────────────────────────────────────────┐
              │           UPGRADE BANNER VISIBLE           │
              │                                            │
              │  ┌──────────────────────────────────────┐  │
              │  │ 🟡 K.Y.T. memory paused — 20/20     │  │
              │  │    turns used today                  │  │
              │  │              [Upgrade to Pro — $7/mo]│  │
              │  │                                   [×]│  │
              │  └──────────────────────────────────────┘  │
              │                                            │
              │  Shadow DOM, fixed bottom, z-index max     │
              │  Style-isolated from host page             │
              └──────────┬──────────────┬──────────────────┘
                         │              │
             ┌───────────┘              └───────────┐
             ▼                                      ▼
    ┌─────────────────┐                   ┌──────────────────┐
    │  USER CLICKS    │                   │  USER CLICKS     │
    │  DISMISS [×]    │                   │  UPGRADE BUTTON  │
    └────────┬────────┘                   └────────┬─────────┘
             │                                     │
             ▼                                     ▼
    ┌─────────────────┐                   ┌──────────────────┐
    │ sessionStorage   │                   │ Button shows     │
    │ .setItem(        │                   │ "Loading..."     │
    │  'kyt_upgrade_   │                   │ disabled = true  │
    │   banner_        │                   │                  │
    │   dismissed','1')│                   │ sendMessage:     │
    │                  │                   │ KYT_START_       │
    │ Banner removed   │                   │ CHECKOUT         │
    │ for this tab     │                   │ { tier: 'pro',   │
    │ session only     │                   │   interval:      │
    │                  │                   │   'monthly' }    │
    └────────┬────────┘                   └────────┬─────────┘
             │                                     │
             ▼                                     ▼
    ┌─────────────────┐              ┌───────────────────────┐
    │  CONTINUE       │              │  message-handlers.js  │
    │  WITHOUT RECALL │              │  case                 │
    │                 │              │  'KYT_START_CHECKOUT' │
    │  Messages still │              │                       │
    │  being captured │              │  getAuthConfig()      │
    │  & synced.      │              │  → supabaseUrl        │
    │                 │              │  → bearerToken         │
    │  Graph still    │              │  → userId              │
    │  growing.       │              │                       │
    │                 │              │  fetch(create-checkout)│
    │  Banner re-     │              │  POST { userId,       │
    │  appears on     │              │    tier, interval }   │
    │  next GET_      │              └───────────┬───────────┘
    │  CONTEXT call   │                          │
    │  (next message  │                          ▼
    │  sent by user)  │              ┌───────────────────────┐
    │                 │              │  create-checkout       │
    │  ⚠️ If user     │              │  (Edge Function)      │
    │  refreshes tab, │              │                       │
    │  sessionStorage │              │  1. Find/create       │
    │  clears →       │              │     Stripe customer   │
    │  banner can     │              │  2. Resolve price ID  │
    │  show again     │              │     tier → price_xxx  │
    │                 │              │  3. Create Checkout   │
    │  ⚠️ Other tabs  │              │     Session           │
    │  still show     │              │  4. Return { url }    │
    │  banner         │              └───────────┬───────────┘
    │  (per-tab       │                          │
    │  sessionStorage)│                          ▼
    └─────────────────┘              ┌───────────────────────┐
                                     │  chrome.tabs.create   │
                                     │  ({ url })            │
                                     │                       │
                                     │  Opens Stripe         │
                                     │  Checkout in new tab  │
                                     │                       │
                                     │  sendResponse:        │
                                     │  { success: true }    │
                                     │  → banner removed     │
                                     │                       │
                                     │  startPostCheckout-   │
                                     │  Poll()               │
                                     │  → polls syncUserTier │
                                     │    every 10s for 2min │
                                     └───────────┬───────────┘
                                                 │
                         ┌───────────────────────┐│┌────────────────────┐
                         ▼                        ││                    ▼
              ┌─────────────────────┐             ││     ┌──────────────────────┐
              │  USER ABANDONS     │             ││     │  USER COMPLETES      │
              │  CHECKOUT          │             ││     │  PAYMENT             │
              │                    │             ││     │                      │
              │  Stripe session    │             ││     │  Stripe processes    │
              │  expires (24h)     │             ││     │  payment, creates    │
              │                    │             ││     │  subscription        │
              │  No webhook fires  │             ││     └──────────┬───────────┘
              │  Nothing changes   │             ││                │
              │                    │             ││                ▼
              │  → Falls through   │             ││     ┌──────────────────────┐
              │    to PATH B       │             ││     │  Stripe fires        │
              │    (next-day       │             ││     │  webhook:            │
              │     reset)         │             ││     │  checkout.session.   │
              └─────────────────────┘             ││     │  completed           │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││
       ══════════════════════════════════════════════════════════════
       ║              PATH A: STRIPE UPGRADE                       ║
       ══════════════════════════════════════════════════════════════
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │  stripe-webhook      │
                                                 ││     │  (Edge Function)     │
                                                 ││     │                      │
                                                 ││     │  1. Verify signature │
                                                 ││     │  2. Idempotency check│
                                                 ││     │  3. Retrieve sub     │
                                                 ││     │  4. Get tier from    │
                                                 ││     │     price ID         │
                                                 ││     │  5. Upsert           │
                                                 ││     │     stripe_          │
                                                 ││     │     subscriptions    │
                                                 ││     │  6. UPDATE users     │
                                                 ││     │     SET tier = 'pro' │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │  TIER SYNC           │
                                                 ││     │  (tier-sync.js)      │
                                                 ││     │                      │
                                                 ││     │  Webhook wrote       │
                                                 ││     │  users.tier = 'pro'  │
                                                 ││     │  in Supabase DB      │
                                                 ││     │                      │
                                                 ││     │  Post-checkout poll  │
                                                 ││     │  (10s interval) OR   │
                                                 ││     │  periodic alarm (5m) │
                                                 ││     │  calls syncUserTier()│
                                                 ││     │                      │
                                                 ││     │  Fetches users.tier  │
                                                 ││     │  via REST API        │
                                                 ││     │  Writes user_tier    │
                                                 ││     │  to chrome.storage   │
                                                 ││     │  .local              │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │  ONCE SYNCED:        │
                                                 ││     │                      │
                                                 ││     │  chrome.storage.     │
                                                 ││     │  local.user_tier     │
                                                 ││     │  = 'pro'             │
                                                 ││     │                      │
                                                 ││     │  Next checkTurnLimit │
                                                 ││     │  → limit = 75       │
                                                 ││     │  → 20 < 75 = true   │
                                                 ││     │  → allowed = true   │
                                                 ││     │                      │
                                                 ││     │  Retrieval pipeline  │
                                                 ││     │  runs again.         │
                                                 ││     │  All 20+ messages    │
                                                 ││     │  already indexed.    │
                                                 ││     │  Instant recall.     │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │       ✅ DONE        │
                                                 ││     │  RECALL RESTORED    │
                                                 ││     │  Banner gone         │
                                                 ││     │  Limit raised to 75  │
                                                 ││     └──────────────────────┘
                                                 ││
                                                 ││
       ══════════════════════════════════════════════════════════════
       ║              PATH B: NEXT-DAY RESET                       ║
       ══════════════════════════════════════════════════════════════
                                                 ││
                                                 ││     ┌──────────────────────┐
                                                 ││     │  Midnight UTC        │
                                                 ││     │  (no alarm needed)   │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │  User sends first    │
                                                 ││     │  message of new day  │
                                                 ││     │                      │
                                                 ││     │  SAVE_MESSAGE fires  │
                                                 ││     │  → incrementTurnCount│
                                                 ││     │  → readTurnData()    │
                                                 ││     │                      │
                                                 ││     │  Lazy reset:         │
                                                 ││     │  data.date =         │
                                                 ││     │   "2026-03-17"       │
                                                 ││     │  today =             │
                                                 ││     │   "2026-03-18"       │
                                                 ││     │  MISMATCH →          │
                                                 ││     │  reset to            │
                                                 ││     │  { date: "2026-03-18"│
                                                 ││     │    count: 0 }        │
                                                 ││     │                      │
                                                 ││     │  Then increments     │
                                                 ││     │  to count: 1         │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │  GET_CONTEXT fires   │
                                                 ││     │                      │
                                                 ││     │  checkTurnLimit()    │
                                                 ││     │  → count: 1         │
                                                 ││     │  → limit: 20        │
                                                 ││     │  → 1 < 20 = true    │
                                                 ││     │  → allowed = true   │
                                                 ││     │                      │
                                                 ││     │  Full retrieval      │
                                                 ││     │  pipeline runs.      │
                                                 ││     │  Yesterday's post-   │
                                                 ││     │  limit messages are  │
                                                 ││     │  already in the      │
                                                 ││     │  graph — searchable  │
                                                 ││     │  immediately.        │
                                                 ││     └──────────┬───────────┘
                                                 ││                │
                                                 ││                ▼
                                                 ││     ┌──────────────────────┐
                                                 ││     │       ✅ DONE        │
                                                 ││     │  RECALL RESTORED    │
                                                 ││     │  Counter reset to 1  │
                                                 ││     │  19 turns remaining  │
                                                 ││     └──────────────────────┘


       ══════════════════════════════════════════════════════════════
       ║         DURING PAUSED STATE (turns 21, 22, 23...)         ║
       ══════════════════════════════════════════════════════════════

              ┌────────────────────────────────────────────┐
              │  Every subsequent message while paused:    │
              │                                            │
              │  SAVE_MESSAGE path:                        │
              │  ✅ saveMessage() — saved                  │
              │  ✅ incrementTurnCount() — count goes up   │
              │  ✅ sync to Supabase — embedded            │
              │  ✅ entity extraction — graph grows         │
              │                                            │
              │  GET_CONTEXT path:                         │
              │  ❌ checkTurnLimit() → allowed: false      │
              │  ❌ Returns empty context                  │
              │  ❌ Banner re-shown (if not dismissed)     │
              │                                            │
              │  Net effect:                               │
              │  • Graph gets richer with every message    │
              │  • User gets no recall assistance          │
              │  • Zero CPU waste (no retry loops)         │
              │  • Zero wasted API calls (pipeline skipped)│
              │  • When limit lifts, everything is ready   │
              └────────────────────────────────────────────┘
```

---

## Tier Sync Mechanism (Implemented)

**Module:** `src/tier-sync.js`

Bridges the gap between Supabase `users.tier` and `chrome.storage.local.user_tier`.
Works bidirectionally — upgrades AND downgrades sync within seconds to minutes.

### Two Sync Triggers

| Trigger | When | Interval | Max Duration |
|---------|------|----------|--------------|
| **Post-checkout poll** | After `KYT_START_CHECKOUT` opens Stripe | Every 10s | 2 minutes |
| **Periodic alarm** | Always running via `syncTier` alarm | Every 5 min | Forever |

### How `syncUserTier()` Works

1. Reads `AUTH_SESSION_KEY` + `user_tier` from `chrome.storage.local`
2. Fetches `users.tier` from Supabase REST API (single row, single column)
3. Validates tier against `VALID_TIERS` set (`free`, `pro`, `founder`, `max`)
4. If changed: writes new `user_tier` to `chrome.storage.local`
5. Returns `{ changed, oldTier, newTier }`

### Upgrade Path (free → pro)

```
User pays → Stripe webhook → users.tier = 'pro'
  → Post-checkout poll detects within 10s
  → chrome.storage.local.user_tier = 'pro'
  → Next checkTurnLimit(): limit = 75, allowed = true
  → Retrieval pipeline runs again immediately
```

### Downgrade Path (pro → free)

```
Stripe subscription.deleted → webhook → users.tier = 'free'
  → Periodic alarm detects within 5 min
  → chrome.storage.local.user_tier = 'free'
  → Next checkTurnLimit(): limit = 20
  → If used > 20 today: retrieval pauses, banner shows
  → Messages CONTINUE being captured and synced
```

### Downgrade Scenarios Handled

| Event | Stripe Webhook | Result |
|-------|----------------|--------|
| User cancels subscription | `subscription.deleted` | `tier = 'free'` (or grace period until `current_period_end`) |
| Payment fails | `invoice.payment_failed` | `status = 'past_due'` (tier kept, Stripe retries) |
| All retries fail | `subscription.deleted` | `tier = 'free'` |
| Admin changes tier | Direct DB update | Periodic alarm catches in ≤5 min |
| Plan downgrade (max→pro) | `subscription.updated` | New tier synced |

### Why This Works for Immediate Downgrades

The `syncTier` alarm runs every 5 minutes. When a downgrade is detected:

1. `syncUserTier()` writes the new (lower) tier to `chrome.storage.local`
2. `checkTurnLimit()` reads `user_tier` on EVERY `GET_CONTEXT` call (no caching)
3. If the user has already exceeded the new, lower limit → retrieval pauses immediately
4. No cached permissions survive the sync — the gate checks live storage every time

---

## Files Referenced

| File | Role |
|------|------|
| `src/tier-sync.js` | `syncUserTier()`, `startPostCheckoutPoll()`, `stopPostCheckoutPoll()` |
| `src/turn-limiter.js` | `checkTurnLimit()`, `incrementTurnCount()`, `readTurnData()` with lazy date reset |
| `src/message-handlers.js:205-223` | Retrieval gate in `handleGetContextAsync()` |
| `src/message-handlers.js:414-418` | Capture path — always saves, always increments |
| `src/message-handlers.js:878-905` | `KYT_START_CHECKOUT` handler → `create-checkout` → post-checkout poll |
| `src/content/upgrade-banner.js` | Shadow DOM banner, `KYT_START_CHECKOUT` on button click |
| `background.js:984` | `syncTier` alarm creation (5 min periodic) |
| `background.js:1258-1267` | `syncTier` alarm handler |
| `supabase/functions/create-checkout/index.ts` | Stripe Checkout session creation |
| `supabase/functions/stripe-webhook/index.ts` | Webhook → `users.tier` update (handles 6 event types) |
| `popup/popup.js:419` | Reads `user_tier` from `chrome.storage.local` |

# K.Y.T. Import Modal — Havara-Inspired Design Brief

## Expert Role & Goal

Act as a senior UX/UI designer specializing in Chrome extension interfaces and behavioral psychology. Design an immersive import onboarding experience for K.Y.T. (Know Your Thoughts), an AI conversation memory extension. The import modal is the user's first substantive interaction with K.Y.T. — it must feel like entrusting their memories to something alive, capable, and trustworthy.

## Constraints

- **Viewport**: 350x600px Chrome popup window (`chrome.windows.create`)
- **Alternate context**: Must also render in `chrome.tabs.create` for first-install tab (full browser width, centered)
- **Runtime**: Chrome MV3 service worker architecture
- **Animations**: Pure CSS keyframes only — no JavaScript animation libraries, no requestAnimationFrame loops
- **Dependencies**: Zero external CSS/JS. Fonts loaded via system stack with fallback (`Inter`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif` for body; `Montserrat` for headings where available)
- **Performance**: All animations must use `transform` and `opacity` only (compositor-friendly). No `will-change` on more than 3 elements simultaneously.
- **Accessibility**: WCAG AA minimum. `prefers-reduced-motion` must disable all animations. Screen reader announcements via `aria-live`.

## Psychological Engagement Tactics

### Bernays (Social Proof & Authority)
- **Welcome view**: "Your AI conversations, remembered." frames K.Y.T. as an authority on memory persistence
- **Data handling card**: "Stored encrypted in your personal database" — institutional trust language
- **Completion badge**: Hexagonal gold badge = achievement symbol (military/institutional reference)

### Kahneman (Loss Aversion & Anchoring)
- **Permission view**: "Bring in your last 90 days" anchors the time value. Subtext "your AI will remember things you've already discussed" triggers loss aversion — skip = lose those memories
- **Progress copy**: "Securing your memories..." frames the import as protective action, not data transfer

### Skinner (Variable Ratio Reinforcement)
- **K.I.T.T. scanner**: Continuous visual reward during import (the sweep is mesmerizing, unpredictable in its correlation to actual progress)
- **Platform checkmarks**: Each completed platform triggers a pink checkmark pop animation — micro-reward per unit of effort
- **Completion ceremony**: 1.5s delay before showing action buttons — lets the gold pulse "land"

### Jung (Archetypes & Symbolism)
- **K.I.T.T. scanner**: Knight Rider reference = the "sentient car" archetype. K.Y.T. is alive, scanning, protecting. Cherry blossom pink subverts the masculine original — adds warmth
- **Dark theme**: The "cave" archetype — safe, enclosed, intimate. Your memories are stored somewhere deep

### Le Bon (Crowd Psychology)
- **Feature list**: "Ask once, remembered forever" / "Search your history" / "You're in control" — three pillars (rule of three), each starting with a power verb
- **Mode selection**: "RECOMMENDED" badge on Full Mode — the crowd chose this

### Nudge Theory
- **Full Mode pre-selected**: Default bias. Green border + "RECOMMENDED" label. Users must actively choose otherwise
- **"Skip for Now"**: Secondary button, muted styling. The skip path exists but isn't visually rewarded
- **Step indicator**: "Step 1 of 3" reduces perceived complexity — the end is visible

## Color Palette

| Color | Hex | Usage |
|-------|-----|-------|
| **Cherry Blossom Pink** | `#FF66B2` | Primary buttons, scanner orb, K.Y.T. tagline, active states, progress fill |
| **Soft Black** | `#1A1A1A` | Body background (all 7 views) |
| **Card Surface** | `rgba(255, 255, 255, 0.04)` | Card backgrounds with glassmorphism |
| **Card Border** | `rgba(255, 102, 178, 0.1)` | Subtle pink-tinted borders |
| **Burgundy** | `#800020` | Secondary button borders, hover accents |
| **Muted Gold** | `#B8860B` | Completion badge, scanner-complete state, success accents |
| **Text Primary** | `#f0f0f0` | Headings, primary body text |
| **Text Secondary** | `#b0b0b0` | Paragraphs, descriptions |
| **Text Tertiary** | `#a0a0a0` | Stats, timestamps, hints |
| **Feature Text** | `#c0c0c0` | List items, instructions |
| **Error** | `#FF6B6B` | Error messages (softened for dark bg) |
| **Error Surface** | `rgba(255, 107, 107, 0.1)` | Error card background |

### Usage Rules
- Cherry Blossom Pink is ONLY for interactive elements and the scanner. Never for large background areas.
- Gold appears ONLY on completion states. Never during active operations.
- Burgundy is accent-only. Never as a primary action color.
- All text must meet WCAG AA contrast ratio (4.5:1) against `#1A1A1A`.

## K.I.T.T. Scanner Animation

### Concept
A horizontal scanner bar beneath the K.Y.T. name and above the progress bar. A glowing pink orb sweeps left-to-right-to-left continuously during import operations. On completion, the orb freezes at center and pulses gold.

### CSS Keyframe Specification

```css
/* Scanner container: 6px tall, full width, dark background, rounded */
.kitt-scanner {
  height: 6px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  position: relative;
  overflow: hidden;
  margin: 12px 0;
}

/* The sweeping orb — only active when .scanning class present */
.kitt-scanner.scanning::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 20px;
  height: 100%;
  border-radius: 3px;
  background: #FF66B2;
  box-shadow: 0 0 15px #FF66B2, 0 0 30px #FF99CC;
  animation: kitt-sweep 2s ease-in-out infinite;
}

/* Bloom trail behind the orb */
.kitt-scanner.scanning::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 60px;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, transparent, rgba(255, 102, 178, 0.4), transparent);
  animation: kitt-sweep 2s ease-in-out infinite;
}

@keyframes kitt-sweep {
  0%   { transform: translateX(0); }
  50%  { transform: translateX(calc(350px - 20px)); }
  100% { transform: translateX(0); }
}

/* Completion state: freeze at center, pulse gold */
.kitt-scanner.scan-complete::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 20px;
  height: 100%;
  border-radius: 3px;
  background: #B8860B;
  box-shadow: 0 0 15px #B8860B, 0 0 30px rgba(184, 134, 11, 0.5);
  animation: kitt-complete 2s ease-in-out 1;
}

@keyframes kitt-complete {
  0%   { box-shadow: 0 0 15px #B8860B, 0 0 30px rgba(184, 134, 11, 0.5); }
  50%  { box-shadow: 0 0 25px #B8860B, 0 0 50px rgba(184, 134, 11, 0.7); }
  100% { box-shadow: 0 0 15px #B8860B, 0 0 30px rgba(184, 134, 11, 0.5); }
}
```

### Behavioral Rules
- **Idle**: No scanner classes. Bar is a subtle dark track.
- **Importing**: `.scanning` class added. Orb sweeps continuously.
- **Complete**: `.scanning` removed, `.scan-complete` added. Orb freezes center, pulses gold once.
- **Reset** (back to platform select): All scanner classes removed.
- **Reduced motion**: Scanner replaced with static pink bar at 50% width (no animation).

## Typography

| Element | Font | Size | Weight | Color |
|---------|------|------|--------|-------|
| H1 | Inter | 18px | 600 | `#f0f0f0` |
| H2 | Inter | 16px | 600 | `#f0f0f0` |
| Body | Inter | 14px | 400 | `#b0b0b0` |
| K.Y.T. tagline | Inter | 15px | 500 | `#FF66B2` |
| Button text | Inter | 14px | 500 | white / `#c0c0c0` |
| Stats | Inter | 12px | 400 | `#a0a0a0` |
| Step indicator | Inter | 12px | 500 | `#a0a0a0` |

No serif fonts. No Montserrat for headings (Inter is sufficient for extension context — fewer font loads). System font stack fallback.

## All 7 View States

### 1. Welcome (first-install step 1/3)
- Dark background `#1A1A1A`
- "Welcome to K.Y.T." in `#f0f0f0`
- "Keep Your Thoughts" tagline in Cherry Blossom Pink
- Data handling card: glassmorphic surface, pink-tinted border
- "Get Started" button: Cherry Blossom Pink, full width

### 2. Mode Select (first-install step 2/3)
- Three mode cards: glassmorphic, clickable
- Full Mode pre-selected: pink border, "RECOMMENDED" in Cherry Blossom Pink (was green)
- Unselected cards: subtle border `rgba(255, 255, 255, 0.1)`
- Selected card: border `#FF66B2`, background `rgba(255, 102, 178, 0.08)`
- "Continue" button: Cherry Blossom Pink

### 3. Permission (first-install step 3/3)
- "Import Your History" heading
- Permission card with feature list
- "Yes, Import History" — Cherry Blossom Pink primary
- "Skip for Now" — Burgundy-bordered secondary

### 4. Platform Select (main view, step 1/3)
- K.I.T.T. scanner bar visible but idle (no animation)
- Platform buttons: Burgundy-bordered secondary, pink when selected
- Completed platforms: Gold with checkmark pop animation
- "Start Import" disabled until platform selected

### 5. Importing (main view, step 2/3)
- K.I.T.T. scanner: `.scanning` — orb sweeping
- Thin 2px progress bar below scanner: pink fill on dark track
- Stats: "Securing your memories... (45%)" left, "1699 msgs" right
- Platform buttons locked (inactive)

### 6. Complete (main view, step 3/3)
- K.I.T.T. scanner: `.scan-complete` — gold pulse
- "Your memories are secured." success message in gold tones
- Gold hexagonal completion badge (CSS-drawn)
- 1.5s delay, then: "Re-import" (secondary) + "Close" (primary, gold-tinted)

### 7. Fallback (ZIP upload)
- Dark glassmorphic card
- Upload zone: dashed pink border, hover brightens
- Platform-specific instructions in `#c0c0c0`
- "Back to Platforms" — Burgundy-bordered secondary

## Micro-Rewards

### Platform Checkmark
When a platform import completes, the button transitions:
1. Background fades to Gold `#B8860B`
2. Checkmark scales from 0 → 1.2 → 1 (bounce)
3. Subtle gold glow pulse on the button
4. Duration: 600ms total

```css
@keyframes checkmark-pop {
  0%   { transform: scale(0); opacity: 0; }
  60%  { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
```

### Completion Badge
CSS-drawn hexagonal badge with gold fill:
1. Scale from 0 → 1 with spring easing
2. Gold glow pulse (one cycle)
3. Appears centered above the success message

```css
@keyframes badge-reveal {
  0%   { transform: scale(0) rotate(-30deg); opacity: 0; }
  70%  { transform: scale(1.1) rotate(0deg); opacity: 1; }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}
```

## Accessibility

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  .kitt-scanner.scanning::before,
  .kitt-scanner.scanning::after {
    animation: none;
    /* Static pink bar at center */
    left: 25%;
    width: 50%;
    opacity: 0.6;
  }
  .kitt-scanner.scan-complete::before {
    animation: none;
  }
  /* Disable all micro-reward animations */
  * { animation-duration: 0.01ms !important; }
}
```

### Screen Reader Support
- `aria-live="polite"` on progress text container
- `role="progressbar"` with `aria-valuenow`, `aria-valuemin="0"`, `aria-valuemax="100"` on progress fill
- Step indicator announced on state change
- Completion badge has `aria-label="Import complete"`

### Contrast Verification
- Cherry Blossom Pink `#FF66B2` on `#1A1A1A`: contrast ratio ~5.2:1 (AA pass)
- Muted Gold `#B8860B` on `#1A1A1A`: contrast ratio ~4.8:1 (AA pass for large text; adjust to `#C9960C` for small text if needed)
- Text Primary `#f0f0f0` on `#1A1A1A`: contrast ratio ~14.5:1 (AAA pass)
- Text Secondary `#b0b0b0` on `#1A1A1A`: contrast ratio ~8.5:1 (AAA pass)

## Technical Constraints

- **No `will-change`** on scanner elements (only 2 pseudo-elements animating)
- **CSS `transform` only** for animations — no `left`/`top` animations (triggers layout)
- **`backdrop-filter: blur(10px)`** for glassmorphism — has GPU cost; limit to visible cards only
- **Font loading**: System stack only. No `@font-face` declarations. Inter loads via system if installed.
- **Z-index budget**: Scanner orb `z-index: 1`, completion badge `z-index: 2`. No higher.
- **Chrome popup constraints**: No `position: fixed` (popup is already fixed). Use `position: relative`/`absolute` within containers.

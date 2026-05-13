# Youth Basketball Roster Management App - Design Document

## 1. Overview

**Purpose:** A Progressive Web App (PWA) for generating equitably timed lineups for youth basketball games structured in halves or quarters.

**TL;DR:** The coach manages multiple teams, defines game duration, and the app generates optimized lineups based on a preset substitution frequency, eliminating real-time data entry during the game. Fully offline-capable with all data stored locally on-device via IndexedDB.

## 2. Scope Boundaries

**Included:**
- Team Management (create, rename, delete multiple teams)
- Player Profiles & Roster Management
- Game Structure Definition (Halves/Quarters & Duration)
- Game-day active roster selection
- Substitution Planning (shift/lineup generation)
- Lineup display table
- Period tracking (check-off as game progresses)
- Emergency roster adjustments mid-game
- Playing time tracking per player

**Excluded (MVP):**
- Live match tracking with actual timestamps
- Stat logging (points, assists, etc.)
- Post-game performance analysis
- Browsing completed games / game history archive
- Cloud sync / multi-device support
- Player positions (guard, forward, center)

## 3. Data Architecture

### 3.1 Local Storage Strategy
**Selected:** Dexie.js (wrapper around IndexedDB)
- Zero server needed — all data stays on-device in the browser's IndexedDB
- Works offline by default (no network required for data access)
- Schema defined in TypeScript with table schemas and indexes
- Reactive queries via `dexie-react-hooks` (`useLiveQuery`), auto-re-renders on data changes
- Mature, well-maintained library (10+ years, 10k+ GitHub stars)
- Versioned schema upgrades with migration callbacks

**Table-Based Approach:** Dexie.js treats IndexedDB as a collection of typed tables:
- Schema defined as `tableName: &primaryKey, index1, index2, ...`
- Type-safe queries with full TypeScript support
- Automatic index management for performant lookups

### 3.2 Entity Model

```
Team (1) ──────< Player
  │
  └───< Game (many)
           │
           └───< Segment (Halves/Quarters)
                    │
                    └───< Shift
                             │
                             └───< Lineup (players on court for that shift)
```

### 3.3 Entity Definitions

| Entity | Fields | Notes |
|--------|--------|-------|
| **Team** | id, name, createdAt | Multi-team supported; user creates/renames/deletes teams |
| **Player** | id, teamId, name, number, isArchived | Jersey number optional; `isArchived` for soft-delete (keeps game history) |
| **Game** | id, teamId, name, activePlayerIds, structure (HALVES/QUARTERS), durationMinutes, substitutionIntervalMinutes, status (DRAFT/ACTIVE/COMPLETED), createdAt | All segments created at game creation time (reviewable before starting). Status flow: DRAFT (pre-start) → ACTIVE (in progress) → COMPLETED (all segments done). `name` defaults to date/time (editable); `activePlayerIds` = JSON array of player IDs active for this game |
| **Segment** | id, gameId, number (1-indexed), label (e.g., "Q1"), status (PENDING/IN_PROGRESS/COMPLETED) | All segments pre-created at game creation. PENDING→IN_PROGRESS on "Complete Segment" advance. Segments can be un-completed for backwards navigation |
| **Shift** | id, segmentId, startMinute, endMinute, lineupJson | Lineup stored as JSON array of player IDs |
| **ShiftSplit** | id, shiftId, minute, playerOutId, playerInId | Tracks injury substitutions within a shift. `minute` defaults to shift midpoint (coach can override). Supports multiple splits per shift |
| **PlannedPlaytime** | id, gameId, playerId, plannedMinutes | Recalculated live on every plan change (re-shuffle, injury sub, late arrival). Not a static snapshot. |

### 3.4 State Management
- `useLiveQuery` hook per component for reactive reads from Dexie/IndexedDB
- Component-local React state for ephemeral UI state (forms, modals, toggles)
- React Router params for screen-level identifiers (gameId, etc.)
- Single source of truth in IndexedDB via Dexie.js — no global store needed
- Repository layer (plain TypeScript modules) wraps Dexie queries for testability

## 4. Algorithm Specification

### 4.1 Fairness Definition
**Goal:** Equal playing time across all active players.

**Constraints:**
- Minimum 5 players required
- Basketball has 5 players on court
- "Fair" = difference in total playtime between any two players ≤ substitution interval

### 4.2 Weighted Random Algorithm with Rest Boost

```
Input: List<Player> activePlayers, Int shiftsPerSegment
Output: List<List<Player>> lineupPerShift (one lineup per shift)

For each shift in the game:
  1. UPDATE running totals: totalPlaytimeMinutes per player (historical + planned so far)
  2. TRACK consecutive shifts PLAYED vs RESTED in the growing plan

  3. For each player, compute selection weight:
     baseWeight      = 1 / (1 + totalPlaytimeMinutes)
     restMultiplier  = 1.0                                    // played last shift
                     = 1 + consecutiveShiftsRested × 0.3     // resting boost, compounds per shift rested
     weight          = baseWeight × restMultiplier

  4. NORMALIZE weights into a probability distribution
  5. WEIGHTED RANDOM pick 5 players without replacement (higher weight = higher chance)
  6. RECORD lineup, advance to next shift
```

**Re-shuffle:** Tapping "Re-shuffle" re-runs the full weighted random selection, producing a different but still equitable distribution. The plan is stable between edits. Emergency roster changes recalculate future shifts only (past shifts remain locked).

**Properties:**
- No remainder handling needed — every shift selects exactly 5 from the pool via weighted random
- Low-playtime players naturally float up via `baseWeight`
- Rested players get an increasing boost the longer they sit via `restMultiplier` (0.3 per shift rested)
- Randomness prevents same-5-group syndrome

**Recalculation carry-over:** Consecutive shift tracking (played/rested counts) carries over across recalculation boundaries. E.g., if a player was on court for 3 consecutive shifts before an injury sub, those 3 count toward their recency weight when future shifts are recalculated.

### 4.3 Edge Case Handling

| Scenario | Handling |
|----------|----------|
| Exactly 5 players | All 5 play entire game; no substitution needed |
| 6+ players | Weighted random picks 5 per shift; rest boost prevents consecutive streaks |
| Injury sub (mid-shift) | Sub out one player. App suggests default replacement (coach overrides). Split shift time 50/50 between injured and sub. Rest of lineup unchanged. |
| Late arrival (pre-game) | Edit gameday roster → full regeneration from scratch |
| Late arrival (mid-game) | Add to active roster → recalculate future shifts only. Past playtime counts toward fairness. |
| Uneven substitution interval | Show warning "shifts don't divide evenly into game length" but allow override |
| Active roster drops below 5 | Show warning only; no hard block (coach forfeits in practice) |
| Player deleted (archived) | Soft-delete: set `isArchived = true`, keep all game history, hide from active rosters |

### 4.4 Emergency Swap Flows

There are three distinct emergency sub scenarios, each with different behavior:

#### Scenario A: Injury Sub (Mid-Shift)

Triggered by tapping a single player on the court and selecting "Sub Out."

1. Coach taps an on-court player → "Sub Out" action
2. App suggests a default replacement (highest-priority bench player based on fairness). Coach can override with any active player not currently on court.
3. Current shift's playtime is **split 50/50**: injured player gets credit for half the shift duration, replacement gets credit for the other half.
4. The rest of the current lineup remains unchanged (only the one injured player is replaced).
5. App recalculates **future** shifts with the updated active pool. Past playtime (including the half-shift credit) counts toward fairness.

#### Scenario B: Late Arrival (Pre-Game)

Triggered by editing the gameday roster before the game has started.

1. Coach taps "Edit Gameday Roster" from Lineup Display screen
2. Coach toggles new player(s) to active (including un-archiving archived players)
3. Coach taps "Save" — does not auto-save on toggle
4. App performs **full regeneration** of all lineups from scratch
5. All shift assignments are replaced

#### Scenario C: Late Arrival / Roster Change (Mid-Game)

Triggered by editing the gameday roster while segments are in progress.

1. Coach taps "Edit Gameday Roster" from Gameday Mode screen
2. Coach adds/removes players from active roster (can un-archive, cannot create new players)
3. Coach taps "Save" — does not auto-save on toggle
4. App recalculates **future shifts only** (current segment onward) with new active pool
5. Past playtime (from completed segments and any in-progress split shifts) counts toward fairness balancing
6. Existing completed segments and shifts remain unchanged

**General rules across all scenarios:**
- No brand-new player creation mid-game. Only existing (including archived) players can be activated.
- No team roster changes mid-game — player names/numbers cannot be edited from Gameday Mode.
- "Save" button required for changes to take effect; toggling alone does not commit.

## 5. Screen Inventory

| Screen | Purpose | Key Elements |
|--------|---------|--------------|
| **Team List** | Manage teams | Team cards (name), Create team button, tap to enter, swipe/long-press to delete |
| **Roster List** | Manage players per team | Player cards (name, #, archived badge), Add/Edit/Delete/Archive, back to team list |
| **Active Player Selection** | Choose game-day roster | List of all team players with toggle switches, "Generate Plan" button (requires ≥5 selected) |
| **Game Setup** | Configure new game | Game name (defaults to date/time, editable), Structure toggle (Halves/Quarters), Duration picker, Substitution interval picker, "Generate Plan" button |
| **Lineup Display** | View generated plan | Segmented tabs (Q1/Q2/etc), Shift table (time, players on court), "Re-shuffle" button, Total playtime per player, "Start Game" button, "Edit Gameday Roster" button |
| **Gameday Mode** | Active game tracking | Current segment/shift display with on-court player list, tap player → "Sub Out" for injury replacement, "Complete Segment" button (auto-advances), "Un-complete" for backwards nav, "Edit Gameday Roster" button |
| **Plan Summary** | Post-game review | Playtime distribution chart, Shifts played per player |

### 5.1 Navigation Flow (React Router v7)

```
/                                     → Team List
/teams/:teamId                        → Roster List
/teams/:teamId/game-setup             → Game Setup
/teams/:teamId/game-setup/select      → Active Player Selection
/teams/:teamId/lineup/:gameId         → Lineup Display
/teams/:teamId/gameday/:gameId        → Gameday Mode
```

**Flow order:** Team List → Roster List → Game Setup → Active Player Selection → Lineup Display → Gameday Mode

### 5.2 Data Flow Between Screens

1. **Team List** → **Roster List:** Selected `teamId`
2. **Roster List** → **Game Setup:** Selected `teamId`
3. **Game Setup** → **Active Player Selection:** Game config (structure, duration, interval). Game NOT yet created in IndexedDB.
4. **Active Player Selection** → **"Create Game" button** → **Lineup Display:** This is the commit point. Game entity is created with config + `activePlayerIds`. All segments are pre-created. Algorithm generates all shifts. Game status: DRAFT.
5. **Lineup Display** → **Gameday Mode:** `gameId`, shifts populated
6. **Gameday Mode** → **Lineup Display:** Status updates (segment completed/un-completed) trigger UI refresh
7. **Emergency Edit — Injury Sub** (Gameday Mode): Tap on-court player → "Sub Out" → app suggests replacement (coach overrides) → split shift 50/50 → recalculate future shifts → stay on Gameday Mode
8. **Emergency Edit — Late Arrival Pre-Game** (Lineup Display): "Edit Gameday Roster" → toggle active players → "Save" → full regeneration → Lineup Display updates
9. **Emergency Edit — Late Arrival Mid-Game** (Gameday Mode): "Edit Gameday Roster" → toggle active players → "Save" → recalculate future shifts → return to Gameday Mode

## 6. User Experience Details

### 6.1 Team Management
- First launch: empty state with "Create your first team" prompt
- Create team: Name (required), tap "Create"
- Rename team: Tap team name to edit inline
- Delete team: Swipe-to-delete with confirmation (cascades all players, games, and history)

### 6.2 Roster Management
- Add player: Name (required), Number (optional)
- Edit player: Inline or modal
- Archive player: Soft-delete (hides from active rosters, preserves game history)
- Un-archive player: Show archived players in a collapsible section, tap to restore
- Validation: No duplicate names, number 0-99 if provided

### 6.3 Game Setup
- Game name: Defaults to current date and time (editable)
- Structure: Segmented button (Halves | Quarters)
- Duration: Number picker (5-30 minutes per segment)
- Substitution: Number picker (1-10 minutes)
- Validation:
  - substitutionInterval ≤ segmentDuration
  - rosterSize ≥ 5
  - Uneven interval: Show warning "shifts don't divide evenly into game length" but allow override

### 6.4 Active Player Selection
- Toggle switches for each team player (on = active for this game)
- Archived players shown in a collapsible "Archived" section (can be un-archived here)
- "Select All" / "Deselect All" shortcuts
- Minimum 5 must be selected to proceed; show count
- **Initial setup mode:** "Generate Plan" button (disabled when < 5 selected)
- **Edit mode** (from Gameday): "Save" / "Cancel" buttons — changes do not auto-save

### 6.5 Lineup Display
- Table format: Shift | Time Range | Players (5 names)
- "Re-shuffle" button to re-randomize lineups (only enabled when game status = DRAFT; locked when ACTIVE)
- Player playtime summary at bottom
- Tap shift to see alternates (who was on bench)
- "Start Game" button to enter Gameday Mode (transitions status from DRAFT → ACTIVE)

### 6.6 Gameday Mode
- Large, glanceable current segment/shift display showing on-court player names
- Tap any on-court player → "Sub Out" action for injury replacement
  - App suggests a default replacement (highest-priority bench player)
  - Coach can override with any active player not on court
  - Confirmation dialog showing: "Sub out [player] for [replacement]? Shift time will be split 50/50."
  - On confirm: lineup updates immediately, shift time split is recorded
- "Edit Gameday Roster" button for late arrivals / planned changes
  - Opens Active Player Selection in edit mode
  - "Save" button commits changes (does not auto-save)
  - "Cancel" discards toggle changes
- "Complete Segment" button auto-advances to next segment
- "Un-complete" button to revert the most recently completed segment (backwards navigation)
- No manual time entry - just advance/retreat segments

### 6.7 Responsive Design & Empty States
- Mobile-first: full-width cards, bottom sheet modals, swipe gestures
- Tablet/desktop: multi-column layouts, side panels
- Empty state: Prompt to create first team when no teams exist
- Empty roster state: Prompt to add first player when roster is empty
- Game history list: "No games yet" with link to Game Setup

## 7. Testing Strategy

### 7.1 Algorithm Unit Tests (Vitest)
Due to weighted randomness, tests use distribution-based assertions with an acceptable tolerance (e.g., "after N iterations, all players have playtime within ±1 shift of expected"). No exact deterministic assertions.

- 5 players: All shifts same lineup (only 5 available)
- 7 players, 4 shifts: Verify playtime converges toward equality within substitution interval
- 10 players, 10 shifts: Verify all players get roughly equal time
- Recency penalty: Verify a player who played 3 consecutive shifts has lower selection probability than one who rested 2 shifts
- Rest boost compounding: Verify `restMultiplier` increases correctly with consecutive shifts rested
- 5 players with 1 removed mid-game: Verify recalculation includes past playtime in fairness
- Injury sub split-shift: Verify 50/50 time credit for injured player and replacement
- Injury sub lineup unchanged: Verify only the subbed player changes in current shift

### 7.2 Edge Case Tests
- Invalid configurations (sub interval > segment duration)
- Empty roster prevention
- Segment completion ordering

### 7.3 UI / Integration Tests (Playwright)
- Navigation between all routes
- Form validation feedback
- Roster CRUD operations
- Dexie DB state verification after user interactions

## 8. Technical Approach

### 8.1 Stack
- **UI:** React 18+ with functional components and hooks
- **Styling:** Tailwind CSS + shadcn/ui (component primitives) + lucide-react (icons)
- **Build:** Vite 6 with TypeScript
- **Routing:** React Router v7
- **Persistence:** Dexie.js (IndexedDB wrapper) + `dexie-react-hooks`
- **PWA:** `vite-plugin-pwa` (service worker, manifest, precaching)
- **Testing:** Vitest (unit) + Playwright (E2E / integration)
- **Linting:** ESLint + Prettier

### 8.2 Project Structure
```
subs/
├── public/
│   └── icons/                  # PWA install icons (192x192, 512x512)
├── src/
│   ├── db/
│   │   ├── schema.ts           # Dexie DB instance + table definitions
│   │   └── repositories/       # Typed query modules (players, games, etc.)
│   ├── algorithm/
│   │   └── lineup.ts           # Round-robin generator (ported from design)
│   ├── routes/
│   │   ├── TeamList.tsx          # Home — team CRUD
│   │   ├── RosterList.tsx        # Player CRUD per team
│   │   ├── GameSetup.tsx         # Configure new game
│   │   ├── ActivePlayerSelect.tsx # Pick game-day roster
│   │   ├── LineupDisplay.tsx     # View generated plan
│   │   └── GamedayMode.tsx       # Active game tracking
│   ├── components/
│   │   ├── ui/                   # shadcn/ui primitives (button, card, dialog, etc.)
│   │   ├── PlayerCard.tsx
│   │   ├── ShiftTable.tsx
│   │   ├── SegmentTabs.tsx
│   │   └── PlaytimeSummary.tsx
│   ├── hooks/                   # Custom React hooks
│   │   └── usePlayers.ts
│   ├── lib/
│   │   └── utils.ts             # shadcn utility (cn() class merging)
│   ├── types.ts                 # TypeScript interfaces
│   ├── App.tsx                  # Router setup
│   ├── main.tsx                 # Entry point
│   └── style.css                # Global styles (or CSS modules)
├── index.html
├── vite.config.ts               # React plugin + VitePWA plugin
├── tsconfig.json
└── package.json
```

### 8.3 Vite + PWA Setup

**Scaffold:**
```bash
npm create vite@latest subs -- --template react-ts
cd subs
npm i dexie dexie-react-hooks react-router-dom lucide-react
npm i -D vite-plugin-pwa tailwindcss @tailwindcss/vite
npx shadcn@latest init  # sets up Tailwind config, CSS variables, cn() utility
```

**vite.config.ts:**
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Subs - Basketball Lineup Manager',
        short_name: 'Subs',
        description: 'Equitable youth basketball lineup generator',
        theme_color: '#1e293b',
        icons: [
          { src: '/icons/192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
    }),
  ],
})
```

### 8.4 Cross-Platform Considerations (PWA)
- Works on any browser that supports IndexedDB (Chrome, Safari, Firefox, Edge)
- Installable on desktop (Chrome, Edge, Safari 16+) and mobile (Android via Chrome, iOS via Safari Share Sheet → Add to Home Screen)
- No app store submission needed — deploy via any static host (Vercel, Netlify, Cloudflare Pages)
- IndexedDB is persistent by default after user interacts with the PWA; no extra permissions needed

### 8.5 UI Theme

**Color Palette (Basketball-themed):**
- Primary (accent): Orange (`#f97316` / orange-500)
- Background (light): White (`#ffffff`)
- Background (dark): Near-black slate (`#0f172a` / slate-900)
- Secondary: Navy blue (`#1e3a5f`)
- Surfaces (dark): Slightly lighter slate (`#1e293b` / slate-800)
- Implemented via shadcn CSS variables with automatic dark mode toggle

**Dark Mode:**
- Supported from MVP launch
- Toggle via system preference (`prefers-color-scheme`) with manual override
- shadcn's `next-themes` equivalent handles class toggling

**Typography:**
- System font stack (no custom font load — faster PWA install):
  `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`

**Icons:**
- `lucide-react` for all UI icons (consistent, lightweight, tree-shakeable)

## 9. Implementation Phases

### Phase 1: Foundation
1. Scaffold Vite + React + TypeScript project
2. Set up Dexie.js with schema definitions
3. Implement Team CRUD + Team List screen
4. Implement Player CRUD + Roster List screen

### Phase 2: Core Engine
1. Implement lineup generation algorithm
2. Implement Game entity + setup screen
3. Implement Lineup generation + display

### Phase 3: Gameday Experience
1. Implement segment/shift tracking
2. Implement emergency roster edit
3. Implement plan recalculation

### Phase 4: Polish
1. Playtime summary views
2. UI/UX refinement
3. Edge case handling verification

## 10. Open Questions

| Question | Recommendation |
|----------|----------------|
| Overtime handling? | MVP: Overtime manually adjusts substitution interval; future: dedicated overtime segment type |
| Running clock vs stoppage? | MVP: User sets "effective playing time" = clock time minus stoppages; future: stoppage logging |
| Save/load game plans? | MVP: Active game only; future: Save drafts for multiple games |
| Export/print lineup? | MVP: Not included; future: Share as image or PDF |
| PWA update strategy? | MVP: `autoUpdate` in vite-plugin-pwa (new SW activates on next page load); future: "Update available" toast with manual reload |
| Data export for backup? | MVP: Not included; future: Export IndexedDB as JSON file, import to restore |
| Browser storage limits? | IndexedDB typically allows 50%+ of free disk space — not a concern for this dataset (KB-scale) |
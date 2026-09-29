# Subs — Youth Basketball Lineup Manager

An offline-first PWA that generates equitable basketball lineups for a whole game
*before* the game starts, so a coach never has to do real-time math with a clock
running.

You pick the game length and how often you want substitutions, and the app
produces a complete rotation: which 5 of your players are on the court for every
shift of every period. During the game you just tap **Complete Shift** and the
plan shows you who the next five are.

All data is stored locally in IndexedDB. There is no server, no account, and no
network requirement after first load.

---

## Features

- **Multiple teams** with per-team rosters (create, rename, delete; delete cascades).
- **Roster management** with jersey numbers, soft-delete via archive, duplicate-name
  and number-range (0–99) validation.
- **Game setup**: quarters (4 × N min) or halves (2 × N min), segment duration
  5–30 min, substitution interval 1–10 min, max consecutive shifts 1–5.
- **Game-day roster selection** — pick exactly who showed up. Archived players can
  be re-activated here without leaving the screen.
- **Lineup display** — per-period shift table with on-court players, plus a
  playing-time bar per player.
- **Re-shuffle** — regenerate an equally fair but different schedule (draft games only).
- **Gameday mode** — a shift-by-shift timeline of the current period with the
  on-court five highlighted, one-tap **Complete Shift**, **Un-complete Last Shift**
  to go backwards, and a transition dialog naming who is leaving and entering at
  each changeover (that dialog is uncommitted work — see
  [Known gaps](#known-gaps-and-current-state)).
- **Emergency substitution** — sub out an injured player mid-shift, pick a
  replacement, and the remaining schedule rebalances automatically.
- **Mid-game roster edits** — add a late arrival or activate a previously benched
  player; future shifts recalculate, completed shifts stay locked.
- **Installable** as a PWA (with an iOS Add-to-Home-Screen fallback prompt, since
  iOS Safari does not fire `beforeinstallprompt`).

---

## Tech stack

| Concern | Choice |
|---|---|
| UI | React 19, function components + hooks |
| Language | TypeScript (strict) |
| Build | Vite 8 |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) + `cn()` (clsx + tailwind-merge) |
| Routing | React Router v7 |
| Persistence | Dexie.js (IndexedDB) + `dexie-react-hooks` |
| Icons | lucide-react |
| PWA | `vite-plugin-pwa` (Workbox, `registerType: 'autoUpdate'`) |
| Unit tests | Vitest, with `fake-indexeddb` so the Dexie repositories can be tested for real |
| Lint | ESLint 10 + typescript-eslint, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh` |
| Deploy | GitHub Actions → GitHub Pages |

There is no global state library. See
[State management](#state-management).

---

## Quick start

**Prerequisites:** Node `^20.19.0 || >=22.12.0` (required by Vite 8). CI is pinned
to Node 20. Note that this is **not** currently declared anywhere in the repo —
there is no `engines` field in `package.json` and no `.nvmrc`, so an old Node
version fails with a Vite error rather than a clear message. Adding both is a
one-line fix if you want it enforced.

```bash
npm ci          # install (use `npm install` if you have no lockfile changes to make)
npm run dev     # dev server with HMR
```

Then open the printed URL (default <http://localhost:5173>).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR + dev-only security headers |
| `npm run build` | Type-check (`tsc -b`) then production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Vitest in watch mode |
| `npm run lint` | ESLint over the repo |

Before pushing, run all three gates:

```bash
npm run lint && npm test && npm run build
```

`dist/` is gitignored, so the working tree stays clean between builds.

---

## How it works

### Game structure model

A game is a fixed set of pre-created records, generated once at creation time so
the whole plan is reviewable before tip-off:

```
Game
├── Segment  (2 for halves, 4 for quarters; pre-created, labelled H1/H2 or Q1–Q4)
│   └── Shift  (ceil(segmentDuration / interval); the last may be shorter)
└── ShiftSplit  (injury substitutions within a shift)
```

Each shift stores its lineup as a JSON array of player IDs in `shift.lineupJson`
rather than as separate join rows. That keeps the shift table small and makes
"read this shift's lineup" a single record fetch; the cost is that querying by
player requires parsing JSON in JS, which is fine at this data volume (KB-scale,
one game = a few dozen shifts).

**Segment and shift counts.** Shifts per segment is `ceil(duration / interval)`.
If `duration % interval !== 0` the final shift is shorter than the others; the
Game Setup screen warns about this but allows it. (The summary card on that
screen shows `floor(duration / interval)` — so it under-reports by one exactly
when the uneven case applies. Cosmetic, but it will read as inconsistent next to
the generated plan.)

### State machines

```
Game:     DRAFT ──Start Game──▶ ACTIVE ──last shift──▶ COMPLETED
Segment:  PENDING ──first shift──▶ IN_PROGRESS ──last shift──▶ COMPLETED
Shift:    PENDING ──advance──▶ CURRENT ──advance──▶ COMPLETED
```

`advanceShift` and `uncompleteShift` (`src/db/repositories/games.ts`) cascade
these together in both directions, which is what makes un-completing work across
a period boundary.

### The lineup algorithm

`src/algorithm/lineup.ts`. This is a **deterministic greedy round-robin**, not the
weighted-random algorithm described in `design.md` §4.2 — see
[Docs](#docs) for why they differ.

`generateLineups` walks shifts in chronological order, carrying a per-player
timeline of `totalPlaytime`, `consecutivePlayed`, and `lastShiftPlayed`. For each
shift it sorts the active players by:

1. **Rested first** — anyone who sat out the previous shift outranks everyone who
   played it. This is what stops a player being benched two shifts in a row
   (guaranteed with 8 or more players; see the soft-bound note below).
2. **Least cumulative playtime first.**
3. **Tiebreaker** — when two players tie on both of the above.

Then it takes the first 5 players who have not hit `maxConsecutiveShifts`.

**Randomization is deliberately narrow, and it only applies to the tiebreaker
step.** A shuffled ordering is built once at entry, and *only if every player
starts with identical playtime*; otherwise no tiebreaker exists and ties break
alphabetically by player ID, making the whole run deterministic. The practical
consequence: a fresh draft or a Re-shuffle varies between calls, but a mid-game
recalculation is fully deterministic — it receives a non-uniform
`existingPlaytime` and will always produce the same answer for the same inputs.
That is arguably a feature (a coach who re-saves an unchanged roster gets an
unchanged plan), but it is worth knowing before you rely on it.

Shuffling only the tiebreaker means "Re-shuffle" produces a genuinely different
schedule while the fairness guarantee is unaffected — every ordering of
equally-eligible players yields equally fair time. Commit `0d0b684` added this
specifically so repeated regenerations stop returning identical schedules.

**The consecutive limit is a soft bound.** If too few players are eligible, the
skipped players are appended anyway (lowest playtime first) — failing to field 5
would be worse than a streak. With the default limit of 2 this engages at 7 or
fewer active players, because resting is already forced and the
least-playtime-but-just-played players get picked straight back. (The exact
threshold moves with the limit; it is a property of the pool size, not a
configurable guarantee.)

**Fairness target.** Total playtime difference between any two active players is
held to within roughly one substitution interval, which is the best achievable
when `activePlayers % 5 != 0`.

### Positions and lineup templates

A player may have a position (`G`, `F`, `C`) or none. **No position means flex** —
eligible for any template slot, not unplayable. That is the default, so an existing
roster with no positions set keeps working exactly as before.

A game may carry a **lineup template**: five slot labels, one per player on court
(`[G,G,F,F,C]`, `[G,G,G,F,F]`, or anything else). It is picked in Game Setup,
snapshotted onto the `Game` at creation, and can pre-fill from the team's default.
A game with **no template** runs the greedy above, unchanged.

When a template is set, the greedy cannot be reused. Ranking five players is a
*sorting* problem; filling five labelled slots is an *assignment* problem, and greedy
slot-filling gets it wrong — it will take the two flex players for the guard slots,
starve the forwards, and produce a broken lineup when a zero-mismatch matching exists.
`src/algorithm/positions.ts` therefore solves it as **min-cost bipartite matching**
(Hungarian/JV) between the active players and the five slots.

**Cost of putting player `p` in slot `s`:**

| Term | Value |
|---|---|
| Playtime | `p.totalPlaytime` |
| Played last shift | `+ REST_PENALTY` = `maxPlaytime − minPlaytime + shiftDuration` |
| At the consecutive limit | `+ CONSEC_PENALTY` = `shiftDuration` |
| Position ≠ slot label | `+ W` |

`W` is the only thing that varies between modes, which is why three priorities need
just one constant:

- **`EQUAL_TIME`** — no solver. The template is ignored entirely; playtime wins.
- **`BALANCED`** — `W = shiftDuration`. The template holds unless breaking it costs
  less than one shift of fairness. Over the 192-case calibration matrix this recovers
  ~87% of the fairness gap while honoring the template on 93% of shifts where the
  template costs nothing.
- **`TEMPLATE`** — `W = Infinity` (mismatch edges deleted). Hard constraint;
  fairness and the consecutive limit yield to it.

**Three rules decide which path runs** (`shouldUseSolver`): the greedy runs when
(a) there is no template, (b) the priority is `EQUAL_TIME`, or (c) the priority is
`BALANCED` *and* the template cannot be satisfied by the active roster **at game
creation**. Rule (c) is create-time only, and `PositionConfig.phase` is required
rather than optional precisely so a call site cannot silently inherit the wrong
answer. Mid-game, an injury that makes the template unsatisfiable keeps the template
as a soft constraint and flags the shift — the coach on the sideline outranks the
plan, and silently reverting to position-blind for every remaining shift would be
worse than a visible, overridable break.

**Two implementation details are load-bearing** and both pass a casual smoke test:

- Rows must be **slots**, columns players — exactly `K` augmentations. Iterating
  players as rows attempts `N − K` extra augmentations and reports spurious
  infeasibility.
- Forbidden edges must be a **finite sentinel** (`BIG_M = 1e9`), not `Infinity`. The
  potential invariant requires finite reduced costs; infeasibility is detected
  afterwards by checking whether the optimum consumed a forbidden edge.

Both are covered by a differential test against a brute-force optimum over random
cost matrices in `src/algorithm/positions.test.ts`.

**A template game is not deterministic, and that is deliberate.** `generateLineups`
builds a shuffled tiebreaker whenever every player starts level (a fresh game, or a
regeneration) and the solver consumes it as an epsilon, so Re-shuffle returns a
different — equally valid — plan instead of a byte-identical one. `EQUAL_TIME` and
`TEMPLATE` are unaffected: the greedy uses no tiebreaker, and `TEMPLATE` has no ties
left to break. The practical consequence is that BALANCED's fairness spread is a
*distribution*, not a number, so the calibration suite measures it over several
samples per case rather than trusting a single call.

**Unsatisfiability is arithmetic, not solver output.** `templateDiagnostics` checks
`n_P + flex >= k_P` per position, because a lockout (`k_P = 0`) is a *feasible*
matching that benches an entire position — deriving it from "max matching < 5" would
report the most dangerous case in the feature as fully satisfiable.

**How the lineup is displayed.** A shift's lineup is a *set* of five players; which one
plays which slot is the coach's call. The stored array happens to be in slot order for
solver output, but the create-phase greedy fallback stores a fairness ranking that
carries no positional meaning. So the UI resolves every lineup to the template
(`resolveToTemplate`) before listing it — grouping the players as the coach reads them,
`G, G, G, F, F` — and the ⚠ markers, the "N of M shifts match" count, and the slot-aware
`suggestReplacement` all read slot indices from that same resolved array. The repair is a
greedy pass, which is fine here (unlike generation, it only has to present a plan
faithfully), and it is the identity function on solver output so nothing reshuffles
between renders. A **flex** player's chip shows the slot they are filling rather than a
placeholder, since a player with no position is playing that spot this shift; a player who
genuinely mismatches still shows their own position, so the chip visibly disagrees with
the slot it is in.

**Known limitation.** A **saturated** position group (`k_P = n_P`, e.g. one guard
against one guard slot) is pinned to 100% of the game by the template itself, and no
setting of `W` can relieve it. The diagnostics panel says so and names `EQUAL_TIME`
as the only mode that changes the outcome, rather than offering Balanced as a fix
that provably does nothing. No condition here blocks game creation — the plan is
generated as close to the template as the roster allows, and each shift that cannot
match is marked with a ⚠.

### Mid-game recalculation

Both `injurySub` and `updateActiveRoster` recalculate the rest of the game the
same way, and this is the subtlest part of the codebase:

1. Lock in playtime already earned — completed shifts, plus the current shift's
   split time.
2. Rebuild per-player consecutive-play state from completed + current shifts via
   `computeTimelineState`.
3. **Flatten every remaining shift across all future segments into one call** to
   `generateLineups`, passing that playtime and state as `existingPlaytime` /
   `existingTimelineState`.
4. Write the generated lineups back over the existing shift rows.

Step 3 is the load-bearing one. Regenerating segment-by-segment would reset
consecutive tracking at every boundary, letting a player who played the last two
shifts of Q1 also open Q2. Flattening keeps the streak intact. Neither function
touches the `plannedPlaytimes` table at all — playtime is always derived from
shifts, never snapshotted.

### Emergency substitution

Tapping **Emergency Sub** in Gameday Mode lets you pick a player on court and a
replacement. `injurySub`:

- moves the outgoing player to `game.injuredPlayerIds` (they are excluded from
  further substitutions and from the bench list),
- swaps them in the current shift's lineup only — the other four are untouched,
- records a `ShiftSplit` at the shift's true midpoint for time accounting,
- recalculates all later shifts against the reduced pool.

The current shift's duration is split 50/50 between the two players, which is what
the design doc specifies. The split is stored as a *position* in the period
(`ShiftSplit.minute`) and converted to a duration by `shiftPlaytime` — keeping
those two separate is what stops a mid-period sub from inflating a player's total.

### State management

- **Server state:** `useLiveQuery` from `dexie-react-hooks`, one per entity per
  screen. Any Dexie write re-renders every subscribed component automatically, so
  there is no manual cache invalidation anywhere in the app.
- **Ephemeral UI state:** local `useState` (form drafts, modal open/closed, which
  player is selected).
- **Navigation state:** React Router params carry `teamId` / `gameId`.
  `ActivePlayerSelect` is dual-purpose and distinguishes its mode by inspecting
  `location.state` — `{ editGameId }` means "mid-game roster edit", anything else
  means "initial selection". This is a little unusual and worth knowing before you
  touch that file.

`src/db/repositories/` wraps all Dexie access in plain async functions. Components
import repositories for writes and query `db` directly for reads.

### Persistence details

- All IDs are `crypto.randomUUID()`.
- Schema is at version 2. The only change from v1 is adding a `status` index to
  `shifts`; `shiftSplits` was present from v1.
- `deleteTeam` performs a manual cascade (splits → shifts → segments →
  playtimes → games → players → team) rather than relying on Dexie's `onDelete`
  cascade, so ordering is explicit.

---

## Project structure

```
src/
├── algorithm/
│   ├── lineup.ts           # fairness engine (round-robin)
│   ├── lineup.test.ts      # 25 tests
│   ├── playtime.ts         # per-shift playtime + substitution splits
│   └── playtime.test.ts    # 15 tests
├── db/
│   ├── schema.ts           # Dexie instance + table/index definitions
│   └── repositories/       # teams.ts · players.ts (CRUD) · games.ts (all game logic)
│       └── games.integration.test.ts  # 3 tests against a real DB
├── routes/                 # one file per screen
│   ├── TeamList.tsx            / → team CRUD
│   ├── RosterList.tsx          /teams/:teamId → player CRUD
│   ├── GameSetup.tsx           /teams/:teamId/game-setup
│   ├── ActivePlayerSelect.tsx  /teams/:teamId/game-setup/select
│   ├── LineupDisplay.tsx       /teams/:teamId/lineup/:gameId
│   └── GamedayMode.tsx         /teams/:teamId/gameday/:gameId
├── components/
│   ├── ui/                 # button · card · dialog · input (shadcn-style, hand-rolled)
│   │   └── PwaInstallPrompt.tsx  # install banner w/ iOS fallback
│   ├── PlaytimeSummary.tsx # post-game distribution bars
│   └── BasketballIcon.tsx
├── hooks/
│   ├── usePwaInstall.ts    # beforeinstallprompt handling
│   └── usePlayers.ts       # ⚠ currently unused
├── test/setup.ts           # fake-indexeddb shim for Vitest
├── lib/utils.ts            # cn()
├── types.ts                # all entity interfaces
├── index.css               # Tailwind import + 16px input guard (iOS zoom)
├── App.tsx                 # router table
└── main.tsx                # entry point
```

### Data model

`Team 1—N Player`, `Team 1—N Game`, `Game 1—N Segment 1—N Shift`,
`Shift 1—N ShiftSplit`.

| Entity | Key fields |
|---|---|
| `Team` | `id`, `name`, `createdAt` |
| `Player` | `id`, `teamId`, `name`, `number?`, `isArchived` |
| `Game` | `id`, `teamId`, `name`, `activePlayerIds[]`, `injuredPlayerIds[]`, `structure`, `durationMinutes`, `substitutionIntervalMinutes`, `maxConsecutiveShifts`, `status`, `createdAt` |
| `Segment` | `id`, `gameId`, `number`, `label`, `status` |
| `Shift` | `id`, `gameId`, `segmentId`, `startMinute`, `endMinute`, `lineupJson`, `status` |
| `ShiftSplit` | `id`, `shiftId`, `minute`, `playerOutId`, `playerInId` |
| `PlannedPlaytime` | `id`, `gameId`, `playerId`, `plannedMinutes` — ⚠ declared but never written; see known gaps |

Player deletion is a soft delete (`isArchived`) so game history survives. Hard
deletes only cascade from `deleteTeam`.

---

## Testing

```bash
npm test
```

43 tests across three files.

`src/algorithm/lineup.test.ts` (25) covers the fairness engine:

- 5 players → identical lineup every shift
- shift counts, partial final shifts, zero-duration and empty-roster edges
- playtime convergence for 7 and 10 players
- `maxConsecutiveShifts` enforcement (hard, and soft when the pool is too small)
- no player benched two shifts running, with 8 players
- consecutive bench **is** allowed with 11+ players
- mid-game injury → return cycle keeps full-game players within one shift
- regeneration actually varies between calls while staying fair
- `existingTimelineState` priority and streak seeding

`src/algorithm/playtime.test.ts` (15) covers shift playtime and substitutions:

- the split point is a true midpoint, not a truncated segment offset
- the sub-in and sub-out players are each credited half a shift
- a segment offset can never leak into a duration
- sub at the very start / very end of a shift
- multiple substitutions in one shift, including a player swapped out and back in
- splits are scoped to their own shift, and input order does not matter

`src/db/repositories/games.integration.test.ts` (3) exercises the real Dexie
repositories against an in-memory IndexedDB (`fake-indexeddb`, wired up in
`src/test/setup.ts`), covering `createGame` → `startGame` → `advanceShift` →
`injurySub` and the draft-roster-edit path end to end.

**Not covered:** the route components have no tests. The design doc proposes
Playwright E2E; that has not been set up.

---

## Deployment

Automatic via `.github/workflows/deploy.yml` on every push to `main`.

```bash
git push origin main   # triggers build + deploy
```

### One-time repository setup

**Settings → Pages → Build and deployment → Source must be set to "GitHub
Actions".** If it is set to "Deploy from a branch", the workflow has nowhere to
publish and the deploy step fails.

### How the base path works

The workflow computes the Vite base path from the repo name:

- user/org page (`owner.github.io`) → `--base="/"`
- project page (everything else) → `--base="/<repo>/"`

`App.tsx` derives the router `basename` from `import.meta.env.BASE_URL`, so the
router follows whatever the build was given. **If you change base-path handling,
change both places.**

### SPA routing on Pages

GitHub Pages has no server-side rewrite, so the workflow copies
`dist/index.html` to `dist/404.html`. Deep links like
`/teams/<id>/gameday/<gameId>` are then served by the 404 page, which boots the
app and lets React Router match the route client-side.

### Update strategy

`registerType: 'autoUpdate'`. vite-plugin-pwa forces Workbox's `skipWaiting` and
`clientsClaim` for this mode, so a newly deployed build is precached and the new
service worker takes control of open tabs immediately — **without waiting for a
reload**. What does *not* happen is the running bundle updating: already-loaded
JavaScript keeps executing, so a coach with the app already open keeps seeing the
old UI until they reload. Worth remembering when testing a deploy on a real
device, or after pushing a fix mid-season.

### Security headers — a known limitation

`vite.config.ts` sets CSP, `X-Frame-Options`, `X-Content-Type-Options`, and
`Referrer-Policy` on the **dev server** only. `index.html` carries a `<meta
http-equiv="Content-Security-Policy">` tag, but it is *not* a copy of the dev
CSP — it omits `frame-ancestors 'none'`, which is the directive that actually
blocks clickjacking. (That directive is ignored in `<meta>` regardless.)

The practical result: **in production, no security headers are actually sent.**
GitHub Pages offers no way to configure them. The meta CSP still restricts
script/style/image/connect sources, but there is no `X-Frame-Options`, no
`nosniff`, and no clickjacking protection. Moving to a host that supports header
configuration (Cloudflare Pages, Netlify, Vercel) would close this properly.

---

## Known gaps and current state

Findings as of the last review. Everything here is safe to pick up; anything
already fixed is recorded under [Recently fixed](#recently-fixed).

### Recently fixed

These were live bugs documented here and have since been fixed. The playtime
accounting bugs (1–3) all shared one root cause: two copies of subtly different
playtime math, one of which treated a `ShiftSplit`'s *position* as a *duration*.
The fix extracts a single `shiftPlaytime` helper in `src/algorithm/playtime.ts`
used by both call sites, so they cannot drift apart again.

**1. `splitMinute` was a segment offset being used as a duration.**
`Math.floor((startMinute + endMinute) / 2)` is an absolute position in the segment,
but it was spent as minutes — so a sub in the period's fourth 5-minute shift
credited the injured player 17 minutes. Now `splitMinuteFor` returns the shift's
true midpoint (17.5 for a 15–20 shift), and `shiftPlaytime` splits the shift's
duration at that position.

**2. In `injurySub`, the substitution recipient got no credit at all.**
The loop iterated the *pre*-swap lineup, so the incoming player was never in it
and the `playerInId` branch was unreachable dead code.

**3. In `updateActiveRoster`, the mirror image: the sub-out player was never
reduced.** This function read the *post*-swap lineup, so its `playerOutId` branch
was the dead one. Bugs 2 and 3 pushed in opposite directions, so the net error
depended on which function had run last.

All three are now covered by regression tests, including a conservation property:
a substitution must redistribute time, never create it, so total playtime always
equals 5 × total shift minutes.

**4. "Edit Gameday Roster" on a draft game created a duplicate instead of
editing.** `LineupDisplay` navigated without `editGameId`, so `ActivePlayerSelect`
treated it as initial setup and minted a new game ID, orphaning the draft. It
also passed no `maxConsecutive`, silently resetting it. `updateActiveRoster` had a
second problem behind this: it returned early whenever no shift was `CURRENT`,
so even with the navigation fixed a draft's lineups would have been left stale
against the new roster. It now regenerates the whole plan for a draft game
(design.md §4.4 Scenario B), and the edit screen returns to the lineup rather than
to Gameday Mode when the game has not started.

A related fairness issue was fixed alongside: the recalculation timeline was
seeded with the *pre*-swap lineup, which marked a player who had just checked in
as rested and gave them an unearned rest boost in the very next shift.

### Dead code

- `PlannedPlaytime` / the `plannedPlaytimes` table is declared in `types.ts` and
  `schema.ts` and only ever touched by the `deleteTeam` cascade. The design doc
  intended live-recalculated rows; the implementation derives playtime from
  shifts instead. Safe to drop in a schema v3.
- `src/hooks/usePlayers.ts` is never imported; every route queries Dexie directly.
- `calculatePlaytime` in `lineup.ts` is used only by tests.
- `class-variance-authority` is a declared runtime dependency that is never
  imported. The UI primitives hand-roll their variant logic with `cn()` instead.

### Not implemented (from the design doc)

- **Dark mode.** The design calls for `prefers-color-scheme` support; every
  Tailwind class in the app is hardcoded light. `theme_color` in the manifest is
  `#1e293b` (slate-800), so the OS title bar and the app body do not match.
- **Game history.** Explicitly excluded from the MVP. There is still no list of
  games anywhere in the UI — every `db.games` read is a single `.get(gameId)` — so
  a game you navigate away from is unreachable. The draft-orphaning case that used
  to trigger this is fixed, but the underlying gap remains.
- **Playwright E2E tests** and Playwright as a dependency.
- **Prettier**, despite the design doc listing it. Formatting is enforced only
  by convention and ESLint.
- **Data export/import** for backup. Because everything is in IndexedDB, clearing
  site data in a browser loses every team and game permanently.

### Lint

`npm run lint` currently reports 2 errors, both pre-existing and unrelated to
any change in progress:

- `src/algorithm/lineup.test.ts:243` — `prefer-const` (`pt` is never reassigned).
- `src/routes/ActivePlayerSelect.tsx:51` — `react-hooks/set-state-in-effect`;
  selection state is seeded from an async query inside an effect.

Tests pass (25/25) and `tsc -b` is clean.

### Uncommitted work

`src/routes/GamedayMode.tsx` has uncommitted changes adding a "Shift Complete"
transition dialog that names the players leaving and entering the court.

---

## Docs

`design.md` is the original product spec and is worth reading for intent, screen
flows, and edge-case reasoning. **It has drifted from the code in one important
way:** §4.2 specifies a *weighted-random with rest-boost* algorithm, and §7.1
specifies distribution-based tests to accommodate that randomness. Commit
`3201931` replaced it with the deterministic round-robin described above, and the
tests were rewritten to assert exact fairness properties instead. §8.2's file
tree also lists components that were never built (`PlayerCard.tsx`,
`ShiftTable.tsx`, `SegmentTabs.tsx`, `style.css`).

Treat `design.md` as the "why" and this README as the "what actually is".

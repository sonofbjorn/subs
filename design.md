# Youth Basketball Roster Management App - Design Document

## 1. Overview

**Purpose:** A Progressive Web App (PWA) for generating equitably timed lineups for youth basketball games structured in halves or quarters.

**TL;DR:** The coach manages multiple teams, defines game duration, and the app generates optimized lineups based on a preset substitution frequency, eliminating real-time data entry during the game. Fully offline-capable with all data stored locally on-device via IndexedDB.

## 2. Scope Boundaries

**Included:**
- Team Management (create, rename, delete multiple teams)
- Player Profiles & Roster Management
- Player positions (G/F/C) and position-aware lineups
- Game Structure Definition (Halves/Quarters & Duration)
- Game-day active roster selection
- Substitution Planning (shift/lineup generation)
- Lineup template (e.g. `[G,G,F,F,C]`) with a coach-chosen priority vs. equal playing time
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
- Multi-position players (e.g. `[G,F]` hybrids) — a player has at most one position, or none (flex)

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
| **Team** | id, name, createdAt, defaultLineupTemplate?, defaultLineupPriority? | Multi-team supported; user creates/renames/deletes teams. The `default*` fields only pre-fill the Game Setup form — a game's own values always win once chosen (see §4.5.7) |
| **Player** | id, teamId, name, number, position?, isArchived | Jersey number optional. `position` is `'G' \| 'F' \| 'C'`, team-level and optional; absent means **flex** — the player is eligible for any template slot (§4.5.1). `isArchived` for soft-delete (keeps game history) |
| **Game** | id, teamId, name, activePlayerIds, structure (HALVES/QUARTERS), durationMinutes, substitutionIntervalMinutes, maxConsecutiveShifts, lineupTemplate?, lineupPriority?, status (DRAFT/ACTIVE/COMPLETED), createdAt | All segments created at game creation time (reviewable before starting). Status flow: DRAFT (pre-start) → ACTIVE (in progress) → COMPLETED (all segments done). `name` defaults to date/time (editable); `activePlayerIds` = JSON array of player IDs active for this game. `lineupTemplate` is a 5-element `Position[]` snapshot; `lineupPriority` is `'BALANCED' \| 'EQUAL_TIME' \| 'TEMPLATE'` and defaults to BALANCED when absent |
| **Segment** | id, gameId, number (1-indexed), label (e.g., "Q1"), status (PENDING/IN_PROGRESS/COMPLETED) | All segments pre-created at game creation. PENDING→IN_PROGRESS on "Complete Segment" advance. Segments can be un-completed for backwards navigation |
| **Shift** | id, segmentId, startMinute, endMinute, lineupJson | Lineup stored as JSON array of player IDs |
| **ShiftSplit** | id, shiftId, minute, playerOutId, playerInId | Tracks injury substitutions within a shift. `minute` defaults to shift midpoint (coach can override). Supports multiple splits per shift |
| **PlannedPlaytime** | id, gameId, playerId, plannedMinutes | Recalculated live on every plan change (re-shuffle, injury sub, late arrival). Not a static snapshot. |

**Schema versioning note:** `position`, `lineupTemplate`, `lineupPriority`, `defaultLineupTemplate`, and `defaultLineupPriority` are all **non-indexed** fields. Dexie only declares indexed properties in `version(n).stores()`, and a read returns the whole stored object, so existing records surface these as `undefined` with **no migration and no new `version(n)` block required**. A version bump would only be needed if one of these later became indexed (e.g. a "find me the centers" query). Every consumer must therefore treat `undefined` as a real case, not just as legacy data: absent template ⇒ play the current position-blind algorithm; absent priority ⇒ BALANCED.

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
| Player has no position | Treated as flex — eligible for any template slot (§4.5.1) |
| Template unsatisfiable by active roster | A position is short (`n_P + flex < k_P`), so every shift mismatches. Warn and name the missing position, offer BALANCED, allow the coach to proceed; solver degrades to closest-achievable and flags mismatching shifts |
| Template has no slot for a position that exists on the roster | Those players can never play. Warn and name them — the *only* true lockout, and a no-center template like `[G,G,G,F,F]` triggers it on any team that has centers |
| Template forces uneven time within a position group | Valid plan, but players sharing a position split fewer slots than they could have (2G/3F/2C under `[G,G,F,F,C]` ⇒ centers 50%, guards 100%). Warn with projected shares. BALANCED bounds this rather than eliminating it (§4.5.4); EQUAL_TIME is the guaranteed fix |
| Template leaves a position exactly saturated (`k_P = n_P`) | That group is pinned to 100% of the game by the template — e.g. one guard against a template with one guard slot. BALANCED only partially corrects this; measured as the residual worst case in §4.5.4. Warn explicitly, and note EQUAL_TIME as the fix |
| No template set | Current position-blind algorithm runs unchanged, whatever the priority (§4.5.4) |
| Player's position edited after the plan exists | Plan is unaffected (lineups are materialized at generation). Offer Re-shuffle on a DRAFT game |

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

### 4.5 Position-Aware Lineup Generation

*(§4.2 above describes the original weighted-random algorithm and is retained for
historical context. The shipped algorithm is the deterministic round-robin greedy in
`src/algorithm/lineup.ts`, which README §"The lineup algorithm" documents
accurately. This section extends **that** implementation.)*

#### 4.5.1 Definitions

```
Position       = 'G' | 'F' | 'C'
lineupTemplate : Position[]   // always exactly 5 — one entry per player on court
lineupPriority : 'BALANCED' | 'EQUAL_TIME' | 'TEMPLATE'
```

- **Flex players.** A player whose `position` is `undefined` is **eligible for every
  slot**. This is the single most important modelling decision in the feature: the
  alternative (unassigned matches nothing) silently excludes every player whose
  position has not been entered, which on a partially-filled roster is a
  playtime-destroying bug the coach only discovers on game day. Flex also makes a
  fully-unassigned roster a legitimate degenerate case — 5 flex players satisfy any
  template.
- **Template scope.** The template is a per-game setting snapshotted onto `Game`
  (§4.5.7), pre-filled from the team's default.

#### 4.5.2 Why the existing sort cannot express a template

`pickLineup` in `src/algorithm/lineup.ts` sorts the whole active pool by
(rested, least playtime, tiebreaker) and takes the first 5. That is a **ranking**
problem. A template constrains *which* five and in what capacity — with `[G,G,F,F,C]`
there is not even a total order on players, only five labelled slots. This is an
**assignment** problem, and the ranking machinery has nowhere to put the information.

#### 4.5.3 Solver: min-cost assignment

Build a bipartite graph of players × template slots, then solve the minimum-cost
perfect matching (5 slots, at most ~15 players ⇒ ≤ 75 edges, 5 augmentations via
successive shortest paths — microseconds, and it runs once per shift).

```
cost(player, slot) =
      playtimeMinutes(player)                      // the fairness objective
    + (lastShiftPlayed(player)      ? REST_PENALTY   : 0)
    + (consecutivePlayed(player) >= maxConsecutive
                                   ? CONSEC_PENALTY  : 0)
    + (positionMismatch(player, slot) ? W          : 0)
```

`positionMismatch` is false when the player's position equals the slot's, or the
player is flex. Ties break on the existing `tiebreaker` rank, then player ID — so
determinism is preserved and a mid-game recalculation with non-uniform
`existingPlaytime` still returns the same plan for the same inputs (README
§"Randomization is deliberately narrow").

**Cost term rationale.** `REST_PENALTY` is computed per shift as
`maxPlaytime − minPlaytime + shiftDuration` across the active pool, which makes a
rested player outrank a played one at *any* playtime gap. That is how the current
lexicographic "rested first" sort is expressed inside an additive cost: the greedy
treats rest as an absolute key and playtime as secondary, and this reproduces that
precedence exactly. `CONSEC_PENALTY = shiftDuration` (a streak costs one shift)
keeps `maxConsecutiveShifts` the soft backstop it is today rather than the dominant
term. `W = shiftDuration` as well, calibrated in §4.5.4. One coherent unit —
"one shift's worth" — governs all three penalties, and the constants are pinned by
the calibration test in §7.4 rather than left to taste.

**Solver implementation note.** The matching is Hungarian/JV with potentials, and
two details are load-bearing rather than stylistic:

- **Rows must be slots, players must be columns**, giving exactly `K` augmentations.
  Iterating rows as players instead attempts `N − K` extra augmentations after all
  slots are already filled and reports spurious infeasibility.
- **Forbidden edges must be a large finite sentinel (`BIG_M`), not `Infinity`.** The
  algorithm's potential invariant requires every reduced cost to stay finite; skipping
  `Infinity` edges mid-search silently yields feasible-but-suboptimal matchings, or
  false infeasibility. Infeasibility is detected afterwards by checking whether the
  optimum consumed a forbidden edge. `BIG_M` only needs to exceed the largest
  possible real cost sum — playtime and the penalties above total well under 10,000
  minutes, so `1e9` is safe by three orders of magnitude.

**Degraded-solve penalty.** §4.5.6 resolves an unsatisfiable template by re-running
with a large finite mismatch penalty. That value must be pinned, and it sits in a
narrow band: above any real cost sum (a whole shift's playtime plus all three
penalties stays under ~2,000 for any realistic game) so it genuinely dominates, and
below `BIG_M` so it is not mistaken for a forbidden edge. `DEGRADE_PENALTY = 10_000`
with `BIG_M = 1e9` leaves two orders of magnitude of headroom on both sides. The
value is arbitrary within that band; what matters is that it is a named constant
with the constraint documented, not an inline literal.

**Unsatisfiability is decided arithmetically, not by the solver.** The check is
`n_P + flex < k_P` for any P (§4.5.6), evaluated up front, and it is authoritative.
The solver's own infeasibility signal is a backstop assertion, not the decision
procedure. This matters because the two detect different things: the arithmetic check
also catches **lockout** (`k_P = 0`, which is a perfectly feasible matching that
benches an entire position), whereas "max matching size < 5" would report that same
roster as fully satisfiable. Deriving satisfiability from the matcher would
therefore silently drop the most dangerous diagnostic in the feature.

Both were found by differential testing against a brute-force optimum over
permutations; the matcher should keep that test (§7.4) because the failure mode is
a plausible-looking wrong answer, not an exception.


#### 4.5.4 The three priority modes

The mode is selected by the constant `W`, plus two path-selection rules.

| Priority | Path | `W` | Effect |
|----------|------|-----|--------|
| `EQUAL_TIME` | existing flat greedy, unchanged | — | Template is ignored entirely. The coach has said playtime wins. |
| `BALANCED` | solver | `shiftDuration` | Template is honored unless doing so costs more than one shift of fairness. |
| `TEMPLATE` | solver | `Infinity` (mismatch edges deleted) | Template is a hard constraint. Fairness, the consecutive limit, and position purity all yield to it. |

**Path-selection rules:** the flat greedy runs when (a) there is no template, (b)
priority is `EQUAL_TIME`, or (c) **BALANCED and the template is unsatisfiable by the
active roster**. A game with no template set therefore behaves exactly as it does
today regardless of priority, and the 15 existing `lineup.test.ts` cases continue to
pass without modification.

Rule (c) matters more than it looks. If a position is short, *every* shift must
mismatch, so the mismatch penalty is charged on every shift for a template that can
never be honored. Measured on a 1G/3F/2C roster under `[G,G,F,F,C]` (one guard, two
guard slots), BALANCED scored a playtime spread of **10 min where EQUAL_TIME managed
5** — it was paying for compliance it could not achieve and distorting the game to
do it. Falling back to the position-blind greedy fixes it and is free: there is
nothing to balance against.

**Rule (c) is evaluated at game creation only, and this distinction is load-bearing.**
It applies to `createGame` — the point where a known-bad plan is still free to
avoid. It does **not** apply to the three mid-game regenerations
(`recalculateLineups`, `injurySub`, `updateActiveRoster`). There, an unsatisfiable
template means a *deliberate, already-committed* situation, not a mistake to correct
away: §6.6's injury sub is explicitly a coach-overridable break of the template, and
the coach on the sideline outranks the plan. A single injury that removes the last
center from a one-center roster would, under an unconditional rule (c), silently
discard the coach's position intent for every remaining shift without asking or
flagging. Instead the template stays a soft constraint: the solver returns the
closest-achievable lineup, the affected shifts carry a ⚠ mismatch marker, and the
coach is told what happened. Silently dropping a stated intent is worse than showing
a broken lineup the coach chose.

This is the one place where the feature defers to the coach over its own optimizer,
and it is why `generateLineups` needs to know *why* it is being called. The
`PositionConfig` gains a `phase: 'create' | 'midgame'` discriminator so rule (c) is
scoped explicitly rather than inferred from status checks scattered across the four
call sites.

`EQUAL_TIME` ignores the template rather than merely de-prioritizing it. This is
deliberate: it lets a coach run a position-aware season while still producing a
purely clock-based plan, without adding a fourth "advisory" mode whose behavior
would be hard to describe. One consequence belongs in the UI copy — choosing
EQUAL_TIME *and* setting a template is not an error, the template simply has no
effect until the priority changes.

**Calibration of `W`.** `W` was originally specified as
`substitutionIntervalMinutes`; it is now specified as the shift's own
`shiftDuration`. **This change is a labeling fix, not a recalibration — the two are
the same number in the shipped code path.** `generateLineups` derives each shift's
length as

```
shiftDuration = Math.min(intervalMinutes, segmentDurationMinutes - minute)
```

so `shiftDuration` *is* the substitution interval on every shift except a short
trailing shift when a segment does not divide evenly. There is no production
configuration in which `W` can be set to something other than the shift length, so
the original "miscalibration" — the claim that `W` was coupled to an unrelated coach
setting and that `W = shiftDuration` measured better (0.075 vs 0.110) — did not
describe a reachable state. The sweep below varies `W` independently of the shift
duration, which the application cannot express; it characterizes the *abstract*
trade, not a choice between two settings.

`W = shiftDuration` remains the right specification, and for the reason that
survives scrutiny: it matches `CONSEC_PENALTY = shiftDuration` and
`REST_PENALTY`'s trailing `+ shiftDuration`, giving one coherent unit — "one shift's
worth" — across the entire cost function. It is also the value that stays correct on
a short trailing shift, where the nominal interval overstates the fairness actually at
stake.

The abstract trade, for reference (`distortion` = 0 means BALANCED matches EQUAL_TIME's
fairness, 1.0 that it is no better than TEMPLATE; `W` expressed as a multiple of the
shift length):

| `W` | distortion | template honored when free |
|-----------|-----------|---------------------------|
| 0.2 × shift | 0.000 | 81% |
| 0.8 × shift | 0.038 | 84% |
| **1.0 × shift (specified)** | **0.127** | **93%** |
| 2.0 × shift | 0.110 | 91% |
| 5.0 × shift | 0.216 | 96% |

Measured through the real `generateLineups` entry point over 192 cases (14 roster
shapes × 3 templates × 4 game shapes), with rule (c) applied; 141 of the 192 are
distorting and 51 are non-distorting. The curve is a straight trade with no knee
below `W ≈ shiftDuration`, so **1.0 × shift is a judgment call, not an optimum**, and
any value in the 3.5–6 minute band is defensible. The calibration test in §7.4 pins
bounds and invariants rather than exact figures so a future retune against a real
season is a one-constant change.

**The specified row is an average, and that distinction matters.** BALANCED is *not*
deterministic: `generateLineups` builds a shuffled tiebreaker whenever every player
starts level, and the solver consumes it, so each call explores a different
tie-broken optimum. The 0.127 is the mean over 7 samples per case. An earlier revision
of this table reported **0.087** from single samples, and the gap was pure luck in the
solver's favor — the expected value is worse than one lucky draw. Every aggregate in
§7.4 is therefore averaged, and any future retune must be measured the same way or it
will look better than it is.

Two further corrections from measuring this properly, both of which had produced wrong
test expectations rather than wrong code:

- **The distortion example is also the saturation example.** 2G/3F/2C under
  `[G,G,F,F,C]` has `k_G = n_G = 2`, so it is *saturated at G* — both guards are on
  court every shift, which is where the 100% figure in the table above comes from.
  Saturation and distortion are one phenomenon measured two ways (`share(P) = 1.0` is
  both "pinned to 100%" and "distorted"), and §"Saturation is not a fourth
  condition" below says what still distinguishes them: the remedy.
- **Spread must count benched players at zero minutes.** Measuring only the players a
  plan seats makes a *lockout* look like perfect fairness — TEMPLATE scoring a spread
  of 0 by seating five players 40/40 while benching the only center. The harness bug
  inverted a real invariant and hid a genuine 40-minute distortion.

**What BALANCED still cannot do.** `W` is a per-shift threshold, but distortion is
cumulative: following the template eight times is eight individually cheap decisions,
not one expensive one. BALANCED therefore does not reliably *eliminate* cumulative
distortion, only bound it. The residual worst case is a **saturated position group**
(`k_P = n_P`, e.g. one guard against a template with one guard slot): that player is
pinned to 100% of the game by the template, and BALANCED only partially corrects it.
This is a genuine limitation, not a tuning oversight, and the honest handling is the
distortion warning in §4.5.6 plus the coach's ability to switch to EQUAL_TIME. Do not
describe BALANCED to coaches as "automatically fixes unfairness" — measured against
EQUAL_TIME across distorting cases it recovers roughly 87% of the gap, and no
setting of `W` reaches 100% without abandoning the template.

**Saturation is not a fourth condition — it is the `k_P = n_P` case of distortion.**
`share(P) = k_P / (n_P + flex)`, so a saturated group has `share = 1.0`: it is pinned
to the whole game while other groups are under-served. The two are one phenomenon
detected two ways, and the canonical distortion example is *both*: 2G/3F/2C under
`[G,G,F,F,C]` has `k_G = n_G = 2`, so both guards are on court every shift — the 100%
figure in the distortion table above — which is exactly what §"Saturated" reports.
The distinction that survives is about the remedy, not the cause: ordinary distortion
leaves `W` something to trade, whereas a saturated group with no flex has nothing left
to trade, which is why §4.5.6 routes it to EQUAL_TIME rather than to Balanced.


#### 4.5.5 Why not greedy slot-filling

The tempting 10-line alternative — walk the slots in scarcity order, take the
best-ranked eligible player — is incorrect, and it fails in exactly the case that
matters (flex players, i.e. a real roster).

> **Counterexample.** Template `[G,G,F,F,C]`. Players: `a`(G), `b`(F), `c`(C),
> `d`(flex), `e`(flex). Fairness order (least playtime first): `d`, `e`, `a`, `b`, `c`.
> Slot scarcity: all three positions have 3 eligible players, so slot order is
> `[G,G,F,F,C]`. The first G slot takes `d`, the second takes `e`, the first F slot
> takes `b`, the second F slot finds only `c` (C-only) — one mismatch — and the C slot
> takes `c` a second time. **The game is broken.** A perfect matching existed and was
> reachable: `[G:a,d] [F:b,e] [C:c]`.

The flex player gets consumed by a slot that already had an exact match waiting,
starving a later slot. Ordering slots by scarcity does not save it, because in the
counterexample all three positions are equally scarce. Only a real matching
guarantees "a feasible assignment exists ⇒ we find one."

#### 4.5.6 Template diagnostics

A template can hurt a roster in three distinct ways. All are detected **before** the
game is created, and they are not variations of one another — the middle one is not
a form of the first, and conflating them is how this feature would mislead a coach.

Let `n_P` = players at position P, `f` = flex players, `k_P` = slots at position P
in the template.

**1. Unsatisfiable — some position is short.**
`n_P + f < k_P` for any P. The matching has no perfect solution, so *every* shift
mismatches. E.g. `[G,G,F,F,C]` against a roster with no centers and no flex. The
solver detects this (max matching size < 5), re-runs with `W` set to a large finite
penalty, and produces the closest achievable lineup; affected shifts are flagged.

**2. Lockout — a position has no slots at all.**
`k_P = 0` while `n_P > 0`. Every player at that position is unplayable, for the
whole game. This is the *only* genuine lockout: a player at a position with at least
one slot can always be placed, and any surplus players at that position simply
rotate. Note that this makes a no-center template the dangerous one, not a
short-roster one — `[G,G,G,F,F]` on a team that has centers benches every center
silently.

**3. Playtime distortion — the important one, and not a failure at all.**
When `n_P + f > k_P`, the players at P must share fewer slots than they could
otherwise have, so they each receive a *reduced but non-zero* share. A 7-player
roster of 2G / 3F / 2C under `[G,G,F,F,C]` locks nobody out — it produces:

| Group | Slots | Players | Share | vs. equal time (5/7) |
|-------|-------|---------|-------|----------------------|
| Guards | 2 | 2 | 100% | 71% |
| Forwards | 2 | 3 | 67% | 71% |
| Centers | 1 | 2 | 50% | 71% |

Everyone plays, the forwards rotate perfectly evenly, and yet the centers are on
court for **half the game** while the guards never leave. Nothing is broken; the
template has simply redistributed the time, and by a lot. This is the failure mode
that will actually generate support complaints, so it gets a warning of its own even
though the plan is perfectly valid.

**Computation.** All three are pure arithmetic on counts — no matching required:

```
satisfiable  ⟺ for every P:  n_P + f ≥ k_P          (plus the existing N ≥ 5)
lockouts     =  { players at P : k_P = 0 and n_P > 0 }
share(P)     =  k_P / max(n_P + f, 1)              // 1.0 = everyone at P always plays
```

Hall's condition on the slot side collapses to the per-position checks plus the
total, because a flex player is eligible for every slot and so only ever relaxes
them. The expensive per-player matching re-run proposed in an earlier draft of this
section is unnecessary — it would have been detecting a case that cannot occur.

**Surfacing.** All three appear on **Active Player Selection**, the first screen
that knows the *active* roster (the template is picked on the preceding screen
against the full team roster, so only a hint is possible there). Each names the
specific problem and offers a one-tap switch to BALANCED. **The coach can always
proceed** — a hard block risks stranding a coach at the sideline with no way to
start, and the degraded output (closest-achievable lineup plus per-shift mismatch
markers) is a more useful artifact than a refusal.

On a **saturated** roster the warning is the whole remedy, not a prompt to switch.
With `k_P = n_P` — one guard against a template with one guard slot — that player is
pinned to 100% of the game no matter which solver runs, so the one-tap "use
BALANCED" offer would send the coach to a mode that cannot help. Detect saturation
and say so directly, naming EQUAL_TIME as the only mode that actually changes the
outcome.

**Which warning offers which remedy.** The "Use Balanced instead" one-tap is only
honest where BALANCED actually changes the result, and the three conditions do not
qualify equally:

| Condition | Offer "Use Balanced" ? | Why |
|---|---|---|
| **Unsatisfiable** | **No — offer EQUAL_TIME** | Rule (c) makes BALANCED fall back to the position-blind greedy here, so BALANCED *is* EQUAL_TIME. Offering it would be a no-op dressed as a fix |
| **Lockout** | **No — offer EQUAL_TIME** | No solver can seat a benched position, but BALANCED would still distort the rest of the game chasing a template that can never hold (§4.5.4) |
| **Saturated** (`k_P = n_P`) | **No — offer EQUAL_TIME** | Measured residual worst case (§4.5.4); BALANCED only partially corrects it |
| **Ordinary distortion** | **Yes** | This is the case the mode exists for — it recovers ~87% of the gap |

This screen is the *create*-phase surface, so rule (c) is in force and the table
applies as written. Offering a one-tap fix that provably cannot help is worse than
naming the mode that can.

#### 4.5.7 Interaction with the rest of the system

- **Signature.** `generateLineups` takes one new optional trailing argument,
  `positionConfig?: PositionConfig`, where
  `PositionConfig = { positions: Map<playerId, Position | undefined>, template?: Position[], priority?: LineupPriority, phase: 'create' | 'midgame' }`.
  Grouped into a single object so the existing seven positional parameters — and the
  tests that pass them — are untouched. An options-bag refactor of the whole
  signature is a reasonable separate cleanup; deliberately not bundled here.
  `phase` is required rather than optional: it is the sole discriminator for
  path-selection rule (c) (§4.5.4), and making it optional would let a call site
  silently inherit the wrong behavior. `createGame` passes `'create'`; the other
  three pass `'midgame'`.
- **All four call sites** in `db/repositories/games.ts` (`createGame`,
  `recalculateLineups`, `injurySub`, `updateActiveRoster`) must thread the config
  through. The two mid-game paths also need a position map assembled from the live
  `Player` records, since the template is read from the stored `Game` while positions
  are read from `players`. `computeTimelineState` is unaffected.
- **Mid-game recalculation stays deterministic.** The solver is seeded by the same
  `tiebreaker` construction, and `existingPlaytime` is non-uniform mid-game, so
  re-saving an unchanged roster yields an unchanged plan.
- **Injury subs.** `suggestReplacement` (`src/routes/GamedayMode.tsx`) currently
  picks the lowest-playtime bench player. When a template is active it should prefer a
  candidate who **fills the vacated slot** (exact position first, then flex, then
  fairness), falling back to current behavior when nobody matches. If the coach
  overrides to a mismatched player, that shift carries a visible mismatch marker — the
  template is a plan, and the coach on the sideline always outranks it.
- **Positions are not snapshotted per game.** Lineups are materialized at generation
  time, so editing a player's position later cannot retroactively alter a plan already
  on disk. No historical copy is needed, and none is stored.
- **The display resolves to the template before it judges.** A shift's lineup is a
  *set* of five players; which one plays which slot is the coach's call, so the stored
  array order is not itself information. It happens to be slot order for solver output,
  but the create-phase greedy fallback (§4.5.4 rule c) stores a fairness ranking that
  carries no positional meaning at all. `resolveToTemplate` therefore reorders any
  lineup into template slot order before the UI lists it, and `slotMismatches` runs on
  the result. This is what makes the ⚠ markers, the "N of M shifts match" count, and
  `suggestReplacement`'s notion of "the slot being vacated" agree with each other; all
  three read slot index from the same resolved array. The repair is a greedy pass, not
  a matching, which is fine: it only has to present a plan faithfully. It is the
  identity function on solver output, so a template game does not reshuffle its players
  between renders. **A flex player's chip shows the slot they are filling**, not a dot —
  a player with no position is playing that spot this shift, so the label is real
  information; a player with a position mismatch keeps showing their own position, so
  the chip still disagrees visibly with the slot it is in.
- **Re-shuffle** keeps its meaning: re-run the same algorithm with a fresh tiebreaker
  order to get a different but equally valid plan. This required the tiebreaker to
  actually reach the solver: `solveShift` originally accepted one and ignored it, which
  made every template-active Re-shuffle return a byte-identical plan — the one thing
  the button exists to prevent. It is now an epsilon term in the cost function, bounded
  far below a single minute so it can only separate otherwise-exact ties. The
  consequence is stated plainly in §4.5.4: **a template-active game is not
  deterministic**, exactly as a position-blind one already was not. In TEMPLATE mode
  every shift still matches the template, so the visible effect is *which* players fill
  each slot, not whether the template holds.

#### 4.5.8 Preset templates

One-tap starting points in Game Setup. The underlying UI is 5 slot chips that each
cycle G → F → C, so arbitrary templates are always reachable.

| Preset | Slots | Use |
|--------|-------|-----|
| **No template** | — | Explicit opt-out. Clears all five chips to flex and stores `lineupTemplate: undefined`, so the game runs the position-blind path. Needed because a team default pre-fills the form: without a visible "off" state, every game would ship a template the coach never chose, and clearing five chips by tapping them would be the only — and undiscoverable — way to remove one |
| Balanced | `[G,G,F,F,C]` | Default when no team default is set. One point guard, two forwards, one center. |
| Passing | `[G,G,G,F,F]` | Ball-mover heavy. **Warn if the roster has centers** — there is no C slot, so they cannot play at all (§4.5.6) |
| Big | `[G,F,F,C,C]` | Youth teams with a tall roster. |
| Custom | — | Anything else, entered by tapping chips. |

"No template" is a real selection, not a cleared form: it must show as an active
preset so the coach can see the template is off without inspecting five empty chips.
Selecting it and then choosing any other preset is the ordinary path back. This is
independent of priority — with no template, all three priorities run the same
position-blind algorithm, so "No template" is the honest control for a coach who
wants positions off entirely rather than merely de-prioritized.

## 5. Screen Inventory

| Screen | Purpose | Key Elements |
|--------|---------|--------------|
| **Team List** | Manage teams | Team cards (name), Create team button, tap to enter, swipe/long-press to delete |
| **Roster List** | Manage players per team | Player cards (name, #, position badge, archived badge), Add/Edit/Delete/Archive, team default lineup template, back to team list |
| **Active Player Selection** | Choose game-day roster | List of all team players with toggle switches, per-player position badge, template feasibility warnings against the selected set, "Generate Plan" button (requires ≥5 selected) |
| **Game Setup** | Configure new game | Game name (defaults to date/time, editable), Structure toggle (Halves/Quarters), Duration picker, Substitution interval picker, Lineup template (preset + 5 slot chips), Priority (Balanced / Equal Time / Template), "Generate Plan" button |
| **Lineup Display** | View generated plan | Segmented tabs (Q1/Q2/etc), Shift table (time, players on court, position chips), template-compliance marker per shift and an "N/M shifts match template" stat, "Re-shuffle" button, Total playtime per player, "Start Game" button, "Edit Gameday Roster" button |
| **Gameday Mode** | Active game tracking | Current segment/shift display with on-court player list (position shown alongside name), tap player → "Sub Out" for injury replacement, "Complete Segment" button (auto-advances), "Un-complete" for backwards nav, "Edit Gameday Roster" button |
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
3. **Game Setup** → **Active Player Selection:** Game config (structure, duration, interval, lineupTemplate, lineupPriority). Game NOT yet created in IndexedDB. The config travels in React Router `location.state`, so the template reaches the next screen for its feasibility check but is not persisted until step 4.
4. **Active Player Selection** → **"Create Game" button** → **Lineup Display:** This is the commit point. Game entity is created with config + `activePlayerIds` + `lineupTemplate` + `lineupPriority`. All segments are pre-created. Algorithm generates all shifts. Game status: DRAFT.
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
- Add player: Name (required), Number (optional), Position (optional)
- Position picker: three chips — G | F | C — plus a "Flex" state, no chip selected. Flex is the default and needs no explanation to the coach; the tooltips carry the explanation
- Position is optional and never blocks saving. A roster with no positions at all is fully usable, because unassigned players are flex (§4.5.1)
- Team default lineup template + priority, set once here and applied to every future game as the pre-filled starting point (§4.5.7)
- Edit player: Inline or modal
- Archive player: Soft-delete (hides from active rosters, preserves game history)
- Un-archive player: Show archived players in a collapsible section, tap to restore
- Validation: No duplicate names, number 0-99 if provided

### 6.3 Game Setup
- Game name: Defaults to current date and time (editable)
- Structure: Segmented button (Halves | Quarters)
- Duration: Number picker (5-30 minutes per segment)
- Substitution: Number picker (1-10 minutes)
- Lineup template: 5 preset buttons (**No template** / Balanced / Passing / Big / Custom) plus 5 slot chips that each cycle G → F → C on tap. Pre-filled from the team default. A live read-out sits under the chips — "No template · position-blind" when off, otherwise "Balanced · G G F F C". The read-out is the coach's confirmation of what was actually stored, so it must state the off case explicitly rather than showing five empty chips
- Priority: Three-way segmented button, with a one-line explanation of the active mode:
  - **Balanced** — "Follow the template unless it costs playing time"
  - **Equal Time** — "Ignore the template; everyone plays equally"
  - **Template** — "Always follow the template, even if someone plays less"
- A soft roster-level hint appears under the template picker when the *full team* roster cannot satisfy it. This is only a hint — the authoritative check is on Active Player Selection, which knows the active roster (§4.5.6)
- Validation:
  - substitutionInterval ≤ segmentDuration
  - rosterSize ≥ 5
  - Uneven interval: Show warning "shifts don't divide evenly into game length" but allow override

### 6.4 Active Player Selection
- Toggle switches for each team player (on = active for this game)
- Position badge shown next to each name, and greyed for flex — the coach needs to see why the template is unhappy
- Template diagnostics panel, shown whenever a template is set and a non-`EQUAL_TIME` priority is active. It re-evaluates on every selection change, and reports whichever of the three conditions in §4.5.6 apply:
  - **Satisfiable, even** — a quiet "✓ Template matched on all shifts" reassurance
  - **Unsatisfiable** — "No centers on this roster", with the closest-achievable shape shown
  - **Lockout** — "2 centers can never play under this template" (only fires for positions with zero slots)
  - **Distortion** — "Under this template centers play ~50% and guards ~100%" with a per-position share breakdown. This is a valid plan, so it is styled as information, not an error — but it is the one a coach most needs to see
  - The one-tap remedy is **per condition**, not uniform: ordinary distortion offers "Use Balanced instead"; unsatisfiable, lockout, and saturated each offer "Use Equal Time instead", because in those three BALANCED provably does not change the outcome (§4.5.6). No condition blocks Create
  - In **edit mode** (reached from Gameday) the panel is read-only — no remedy buttons, since template and priority are DRAFT-time settings (§10). It reports the condition and names the fix for next time rather than offering to apply it now
- Archived players shown in a collapsible "Archived" section (can be un-archived here)
- "Select All" / "Deselect All" shortcuts
- Minimum 5 must be selected to proceed; show count
- **Initial setup mode:** "Generate Plan" button (disabled when < 5 selected)
- **Edit mode** (from Gameday): "Save" / "Cancel" buttons — changes do not auto-save

### 6.5 Lineup Display
- Table format: Shift | Time Range | Players (5 names)
- Position chips on each player (subtle G/F/C badge; flex players unmarked), plus a per-shift template marker — ✓ when the shift matches, ⚠ when it does not
- Template compliance stat above the table: "8/8 shifts match template" whenever a template is set. This is what makes `TEMPLATE` mode auditable rather than a black box
- "Re-shuffle" button to re-randomize lineups (only enabled when game status = DRAFT; locked when ACTIVE)
- Player playtime summary at bottom
- Tap shift to see alternates (who was on bench)
- "Start Game" button to enter Gameday Mode (transitions status from DRAFT → ACTIVE)

### 6.6 Gameday Mode
- Large, glanceable current segment/shift display showing on-court player names, each with their position badge
- Tap any on-court player → "Sub Out" action for injury replacement
  - App suggests a default replacement (highest-priority bench player)
  - When a template is active, the suggestion prefers a player who fills the vacated position, then a flex player, then fairness (§4.5.7)
  - Coach can override with any active player not on court
  - Confirmation dialog showing: "Sub out [player] for [replacement]? Shift time will be split 50/50."
  - On confirm: lineup updates immediately, shift time split is recorded
  - If the replacement does not match the slot they fill, the current shift shows a ⚠ mismatch marker — a deliberate, coach-overridable break of the template (§4.5.6)
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

### 7.4 Position & Template Tests (`algorithm/positions.test.ts`)

**Solver correctness**
- The §4.5.5 counterexample verbatim: `[G,G,F,F,C]` with `a`(G) `b`(F) `c`(C) `d`(flex) `e`(flex), fairness order `d, e, a, b, c` must yield a **zero-mismatch** lineup. This is the test that fails loudly if someone "simplifies" the solver into greedy slot-filling
- **Differential test against a brute-force optimum** over 5-slot permutations, on randomly generated cost matrices with ~35% forbidden edges, asserting equal totals and that infeasibility is reported only when no permitted assignment exists. Both implementation traps in §4.5.3 (row orientation, `Infinity` edges) pass a casual smoke test and fail this one
- Template is satisfied exactly on **every** shift when the roster can satisfy it (satisfiable rosters, 20 iterations, to catch nondeterminism)
- Assignment respects `maxConsecutiveShifts` where possible under `BALANCED`, and may exceed it under `TEMPLATE` — both asserted, since the difference is intentional
- Solver is deterministic: same inputs, same output across 20 runs, given a fixed tiebreaker
- Every returned lineup has exactly 5 distinct active players, for all three modes

**Calibration matrix** (the guard on `W`)
A parameterized suite over 14 roster shapes × 3 templates × 4 game shapes (192
cases). This suite **is** the calibration harness — the sweep that produced the
§4.5.4 table runs as a parameterized test rather than living in a throwaway script,
so every number in that table is reproducible from `npm test` and stays honest when
the constants change. It measures through the real `generateLineups` entry point,
**not** a reimplementation of the loop: a first draft inlined a simplified
position-blind greedy with no consecutive limit, which measured the solver against a
baseline the product does not use and reported a better distortion than reality.

BALANCED is stochastic, so aggregates are averaged over 7 samples per case and the
dominance invariant is checked against the *worst* sample, not the mean.
Asserting the measured properties of `W = shiftDuration`:
- BALANCED's distortion on distorting cases stays below **0.20** (measured: 0.127, i.e. ~87% recovery)
- Template compliance on non-distorting cases stays above **85%** (measured: 93%)
- BALANCED is never *worse* than TEMPLATE on playtime spread, on any of its 7 samples
- The canonical 2G/3F/2C / `[G,G,F,F,C]` / 8×5min case is asserted numerically where the values are deterministic (EQUAL_TIME spread 5, TEMPLATE spread 20) and as a **band** for BALANCED (spread within [5, 20], always bending at least once). Asserting BALANCED's exact per-sample numbers was wrong: they vary by design, so a fixed expectation would have failed on a correct implementation
- TEMPLATE mismatches zero shifts on **satisfiable** rosters only. Asserting zero across the whole matrix would be asserting that every template is fillable, which is false by construction
- The `W` tiebreaker is an **epsilon**, asserted to never outweigh a real minute of cost: a center with one minute less playtime must win the center slot at every possible tiebreaker rank
- Every active player is included in the playtime spread at **0 minutes** if never seated. This is load-bearing, not bookkeeping: omitting them made a *lockout* look like perfect fairness (TEMPLATE scoring a spread of 0 by seating five players 40/40 while benching the only center), which in turn masked a false failure in the invariant above
- `EQUAL_TIME` and `TEMPLATE` are deterministic across repeated calls, so the substitution interval is not an independent input and there is nothing for a coach setting to perturb. BALANCED is deliberately excluded from that assertion

**Mode semantics**
- `EQUAL_TIME` with a template set produces the same playtime spread as no template at all
- `BALANCED` honors the template whenever doing so costs ≤ `W`
- `BALANCED` abandons the template when honoring it would exceed `W`
- `BALANCED` on an **unsatisfiable** template produces output identical to `EQUAL_TIME` at `phase: 'create'` (path-selection rule (c)) — regression guard for the 10-vs-5 spread bug
- `BALANCED` on an unsatisfiable template at `phase: 'midgame'` does **not** fall back: it keeps the template as a soft constraint and flags every unmatchable shift. Assert that a mid-game roster change which makes the template unsatisfiable still produces template-aware lineups rather than silently reverting to position-blind
- `phase` is the only thing that scopes rule (c): identical inputs at `'create'` and `'midgame'` on an unsatisfiable template must differ, which is the test that keeps the distinction from being accidentally collapsed
- `TEMPLATE` matches the template on 100% of shifts even when fairness suffers
- No template ⇒ output identical to today's algorithm (regression guard on the 15 existing cases, run unchanged)
- All three priorities with **no template** produce byte-identical lineups — the "No template" preset is a real off switch, not a soft preference


**Flex behavior**
- A flex player fills an exact-match slot when that is the cheapest option
- 5 flex players satisfy any template
- A roster with zero positions assigned generates normally, with no template violations

**Diagnostics** (`templateDiagnostics`)
- `[G,G,F,F,C]` with no centers and no flex players ⇒ reports unsatisfiable, names the missing position
- `[G,G,G,F,F]` with 2 centers on the roster ⇒ reports 2 lockouts, names the centers. This is the only real lockout case; there is deliberately **no** test asserting lockout for a surplus position, because surplus players rotate
- 5 flex players ⇒ reports satisfied, no warnings
- 2G/3F/2C under `[G,G,F,F,C]` ⇒ reports **no lockouts and no infeasibility**, but reports distortion with shares 1.0 / 0.67 / 0.5. Guards against regressing this into a false lockout warning
- Distortion shares are asserted numerically, not just "a warning exists": `share(P) = k_P / (n_P + flex)`
- Degraded solve still returns 5 valid players, and the mismatch count matches the reported diagnosis
- Diagnosis re-runs correctly as the active selection changes (add/remove players)

**Distortion behaviour** (the mode interaction this design turns on)
- TEMPLATE over 2G/3F/2C with `[G,G,F,F,C]`, 8×5 min, produces exactly the projected
  distortion — guards 40/40, forwards 30/25/25, centers 20/20, spread 20 against an
  equal-time spread of 5 — and reports a template match on every shift
- BALANCED over the same roster lands somewhere between the two on every sample —
  asserted as a **band** (spread within [5, 20], always bending at least once), not as
  a single figure. An earlier revision asserted the exact figures (spread 10, 2 of 8
  shifts) and failed against a correct implementation, because BALANCED is stochastic
  and those were one lucky sample. The design's earlier claim that BALANCED "returns
  near-equal time on its own" is false here, and a test written to that claim would
  have locked the error in
- EQUAL_TIME over the same roster is the 5-minute baseline the other two are measured
  against
- The three results differ and are all reachable, which is the point of having three
  modes — but BALANCED's value is *bounding* distortion, not eliminating it, and the
  tests should say so

**Display resolution** (`resolveToTemplate`)
- Identity on solver output, so a template game never reshuffles its players between renders
- Repairs a fairness-ordered lineup (§4.5.4 rule c output) into `G,G,F,F,C` grouping with zero mismatches — the regression guard for the scrambled chips, misflagged players, and wrong compliance count that reading a greedy lineup as slot order produced
- An exact position match claims its slot **before** a flex player takes it, so the repair cannot introduce the mismatch it is there to remove
- Keeps every player when a slot has no candidate at all (a lockout): length and membership are asserted, not just ordering
- Deterministic, so the display is stable across renders
- `slotMismatches` stays order-sensitive. The fix was to resolve first, not to make the checker order-blind; a test asserting a sorted lineup still mismatches is retained deliberately, because it is what forces callers through the resolver

**Call-site integration** (`db/repositories/games.integration.test.ts`, real in-memory Dexie)
The unit suite proves the *algorithm* honours `phase`; only an integration test can
prove each of the four call sites passes the right one. Asserting the same property in
both places is not redundant — a mis-wired `phase` is invisible to the unit tests.
- `createGame` snapshots `lineupTemplate` and `lineupPriority` onto the `Game`
- `createGame` with neither leaves **both fields absent**, not `priority` set with no
  template. The "No template" preset is a real off switch, and `buildPositionConfig`
  returning `undefined` is what guarantees the position-blind path runs with no
  position lookup at all
- A TEMPLATE-priority game satisfies the template on every stored shift row
- **The mid-game soft-constraint test and its create-time contrast.** Same roster,
  same template, same priority, same pinned `Math.random` — only `phase` differs, and
  the output is structurally different: after a mid-game injury removes both centers,
  every future shift still has guards in the two guard slots, whereas the create-phase
  fallback rotates names through slots positionlessly and aligns 0 of 16 times. The
  shuffle **must** be pinned (`Math.random` → 0.5) for this to be a test at all:
  unpinned, the fallback satisfies the mid-game assertion by luck roughly half the
  time, which makes the test meaningless in both directions
- Positions are re-read live, so correcting a mislabeled player changes the next
  regenerated plan while the template stays frozen on the game

**Playtime & mid-game**
- `injurySub` and `updateActiveRoster` preserve template compliance on regenerated future shifts
- `suggestReplacement` prefers an exact position match, then flex, then fairness — asserted directly
- An overridden mismatched sub is recorded and surfaced as a mismatch, not silently normalized
- Editing a player's position after generation leaves stored lineups untouched

**Migration**
- A game row written before this feature (no `lineupTemplate`, no `lineupPriority`) loads and regenerates without error, defaulting to `BALANCED` + no template

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

### Phase 5: Positions & Lineup Template (§4.5)
Sequenced so each step is independently shippable and the risky part lands first.

1. **Types + storage only.** `Position`, `LineupPriority`, `Player.position`, `Game.lineupTemplate`/`lineupPriority`, `Team.default*`. No behavior change; no migration required (§3.3). Trivially revertible.
2. **Solver + diagnostics, not yet wired to the UI.** `algorithm/positions.ts` with the min-cost matching, `templateDiagnostics`, and the full §7.4 test suite. This is the step that can invalidate the design, and it is worth landing behind no UI so a rewrite costs nothing.
3. **Thread the config through the four `generateLineups` call sites** in `db/repositories/games.ts`. No template set ⇒ the flat greedy path ⇒ output unchanged; the 15 existing tests stay green as the safety net.
4. **Roster List position picker + team default.**
5. **Game Setup template + priority UI.**
6. **Active Player Selection feasibility panel.** Lands after 5 because it is the screen that consumes both.
7. **Lineup Display / Gameday Mode position chips + compliance markers + position-aware `suggestReplacement`.**
8. **README update** — README §"The lineup algorithm" currently describes the position-blind greedy and will need the template path documented alongside it.

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
| Right `W` for `BALANCED`? | **Resolved**, and the question dissolved on inspection. `W` is the shift's own `shiftDuration` — which in the shipped code *is* the substitution interval, so "interval basis vs shift basis" was never a reachable alternative and the original miscalibration claim was an artifact of a simulation that could vary `W` independently of the shift length. The surviving reason to specify `shiftDuration` is unit coherence with `CONSEC_PENALTY` and `REST_PENALTY` (§4.5.4), plus correctness on short trailing shifts. Measured distortion 0.127, compliance 93% over 192 cases, both averaged over 7 samples because BALANCED is stochastic. Still a named constant: the calibration test pins its *semantics*, so changing the value cannot silently change the contract |
| Multi-position players (`[G,F]` hybrids)? | Out of scope. When added, eligibility becomes "position ∈ slot" and the solver is unchanged; both §4.5.6 diagnostics shift meaningfully, since a G/C hybrid resolves a `[G,G,G,F,F]` lockout outright and the per-position distortion math has to account for overlapping eligibility pools |
| Should positions be editable from Gameday Mode? | No. Same rule as names and numbers (§4.4) — mid-game edits change the plan the coach is looking at |
| What if a coach sets a template mid-game? | Not supported. Template and priority are DRAFT-time settings. The active-player's actual positions can change freely, since positions are read live at generation |
| How does a coach turn the template *off*? | **Resolved.** "No template" is a real preset alongside Balanced / Passing / Big / Custom (§4.5.8), storing `lineupTemplate: undefined` and reading out as "No template · position-blind". Needed because a team default pre-fills the form — without a visible off state, every game would ship a template the coach never chose, and the only alternative was clearing five chips by tapping them |
| Does path-selection rule (c) apply mid-game? | **Resolved.** Generation-time only. `PositionConfig.phase` (`'create' \| 'midgame'`) is the sole discriminator. An unsatisfiable template mid-game is a committed, coach-owned situation, not a mistake to correct away — silently discarding the coach's position intent for the rest of the game is worse than showing a flagged, coach-overridable break (§4.5.4) |
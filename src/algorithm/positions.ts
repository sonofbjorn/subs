/**
 * Position-aware lineup solving (design.md §4.5).
 *
 * The shipped algorithm in `lineup.ts` is a deterministic round-robin greedy: it ranks
 * the whole active pool by (rested, least playtime, tiebreaker) and takes the first
 * five. That is a *ranking* problem. A template constrains *which* five and in what
 * capacity — with [G,G,F,F,C] there is no total order on players at all, only five
 * labelled slots. This module solves that as the *assignment* problem it really is.
 *
 * See design.md §4.5.5 for why greedy slot-filling is not an acceptable substitute.
 */

import type { LineupPriority, LineupTemplate, Position } from '../types'

/**
 * Which solver path to use, and with what inputs.
 *
 * `phase` is required rather than optional on purpose: it is the sole discriminator
 * for path-selection rule (c) (design.md §4.5.4), and defaulting it would let a call
 * site silently inherit the wrong behavior. `createGame` passes 'create'; the three
 * mid-game regenerations pass 'midgame'.
 */
export interface PositionConfig {
  positions: Map<string, Position | undefined>
  template?: LineupTemplate
  priority?: LineupPriority
  phase: 'create' | 'midgame'
}

const ON_COURT = 5

/**
 * Must exceed any real cost sum (a whole shift's playtime plus all three penalties
 * stays under ~2,000 for any realistic game) and stay well below `BIG_M` so it is
 * never mistaken for a forbidden edge. The value is arbitrary within that band; what
 * matters is that it is named and documented rather than an inline literal.
 */
export const DEGRADE_PENALTY = 10_000

/**
 * Must exceed the largest possible real cost sum. Playtime and the penalties above
 * total well under 10,000 minutes, so 1e9 is safe by three orders of magnitude.
 *
 * Forbidden edges are modelled as this large finite sentinel rather than `Infinity`:
 * the Hungarian potential invariant requires every reduced cost to stay finite, and
 * skipping `Infinity` edges mid-search silently yields feasible-but-suboptimal
 * matchings or false infeasibility. Infeasibility is detected afterwards by checking
 * whether the optimum consumed a forbidden edge.
 */
export const BIG_M = 1e9

/**
 * Weight of the tiebreaker rank inside the cost function.
 *
 * Small enough that a full roster's worth of tiebreaker spread can never outweigh a
 * single minute of real cost (all other terms are whole minutes, and a roster is
 * nowhere near 1e6 players), so it only ever separates assignments that are otherwise
 * exactly equal.
 */
const TIEBREAK_EPSILON = 1e-6


/**
 * Min-cost bipartite matching: assign all K slots to K distinct players drawn from
 * N >= K candidates.
 *
 * `cost(playerIndex, slotIndex)` returns a number, or a value >= BIG_M for a forbidden
 * edge. Returns `{ total, chosen }` where `chosen[slot] = playerIndex`, or `null` when
 * no assignment exists using only permitted edges.
 *
 * Two implementation details are load-bearing, both found by differential testing
 * against a brute-force optimum (see `positions.test.ts`) because the failure mode is
 * a plausible-looking wrong answer rather than an exception:
 *
 * - Rows must be **slots**, players must be columns, giving exactly K augmentations.
 *   Iterating rows as players attempts N-K extra augmentations after all slots are
 *   already filled and reports spurious infeasibility.
 * - Forbidden edges must be a finite sentinel, not `Infinity` (see `BIG_M`).
 */
export function assign(
  cost: (playerIndex: number, slotIndex: number) => number,
  playerCount: number,
  slotCount: number,
): { total: number; chosen: number[] } | null {
  // Potentials: u indexed by slot (row), v indexed by player (column).
  const u = new Float64Array(slotCount + 1)
  const v = new Float64Array(playerCount + 1)
  const p = new Int32Array(playerCount + 1) // p[player] = slot assigned to that player
  const way = new Int32Array(playerCount + 1)

  for (let i = 1; i <= slotCount; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(playerCount + 1).fill(Infinity)
    const used = new Uint8Array(playerCount + 1)

    do {
      used[j0] = 1
      const i0 = p[j0]
      let delta = Infinity
      let j1 = -1
      for (let j = 1; j <= playerCount; j++) {
        if (used[j]) continue
        const raw = cost(j - 1, i0 - 1)
        const c = raw >= BIG_M ? BIG_M : raw
        const cur = c - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      // No augmenting path: this slot cannot be filled from the remaining players.
      if (j1 === -1) return null

      for (let j = 0; j <= playerCount; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else if (minv[j] < Infinity) {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)

    // Walk the augmenting path back, reassigning slots along it.
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }

  const chosen = new Array<number>(slotCount).fill(-1)
  let total = 0
  for (let j = 1; j <= playerCount; j++) {
    if (!p[j]) continue
    const raw = cost(j - 1, p[j] - 1)
    if (raw >= BIG_M) return null // optimum consumed a forbidden edge
    chosen[p[j] - 1] = j - 1
    total += raw
  }
  return { total, chosen }
}

export interface TemplateDiagnosis {
  /** No position is short, so a perfect matching exists for every shift. */
  satisfiable: boolean
  /** Positions that have at least one player but zero slots — nobody at them can play. */
  lockoutPositions: Position[]
  /** Which positions are short, for the "no centers on this roster" message. */
  shortPositions: Position[]
  /**
   * `share(P) = k_P / (n_P + flex)` — the fraction of the game a player at P plays
   * under a perfect template. 1.0 means always on court.
   */
  shares: Record<Position, number>
  /**
   * `k_P = n_P`: the position has exactly as many players as slots, so every one of
   * them is pinned to 100% of the game. No solver can improve this; the fix is
   * EQUAL_TIME. (design.md §4.5.4)
   */
  saturatedPositions: Position[]
  /** Any of the above three is a reason the coach should see the panel. */
  hasWarning: boolean
}

/**
 * Pure arithmetic over position counts — no matching required. Hall's condition on the
 * slot side collapses to these per-position checks plus the existing N >= 5, because a
 * flex player is eligible for every slot and so only ever relaxes them.
 *
 * Deliberately NOT derived from the solver's own infeasibility signal: a lockout
 * (`k_P = 0`) is a perfectly feasible matching that benches an entire position, so
 * "max matching size < 5" would report it as fully satisfiable and drop the most
 * dangerous diagnostic in the feature.
 */
export function templateDiagnostics(
  activePlayerIds: string[],
  positions: Map<string, Position | undefined>,
  template: LineupTemplate,
): TemplateDiagnosis {
  const nP: Record<Position, number> = { G: 0, F: 0, C: 0 }
  let flex = 0
  for (const id of activePlayerIds) {
    const pos = positions.get(id)
    if (pos === undefined) flex++
    else nP[pos]++
  }

  const kP: Record<Position, number> = { G: 0, F: 0, C: 0 }
  for (const slot of template) kP[slot]++

  const all: Position[] = ['G', 'F', 'C']
  const shortPositions = all.filter(p => nP[p] + flex < kP[p])
  const lockoutPositions = all.filter(p => kP[p] === 0 && nP[p] > 0)
  const saturatedPositions = all.filter(p => kP[p] > 0 && nP[p] === kP[p] && flex === 0)

  const shares: Record<Position, number> = { G: 0, F: 0, C: 0 }
  for (const p of all) {
    const pool = Math.max(nP[p] + flex, 1)
    shares[p] = kP[p] === 0 ? 0 : kP[p] / pool
  }

  const satisfiable = shortPositions.length === 0
  return {
    satisfiable,
    lockoutPositions,
    shortPositions,
    shares,
    saturatedPositions,
    hasWarning: !satisfiable || lockoutPositions.length > 0 || saturatedPositions.length > 0,
  }
}

interface TimelineLike {
  totalPlaytime: number
  consecutivePlayed: number
  lastShiftPlayed: boolean
}

/**
 * Which slots of a generated lineup fail to match the template, as slot indices.
 *
 * Depends on the solver's slot ordering, so it must be called on `lineup` exactly as
 * `generateLineups` produced it. Sorting a lineup by name before checking it - which the
 * display layer used to do - silently invalidates the result.
 *
 * A player with no position never counts as a mismatch: they are flex, and filling any
 * slot is the whole point of leaving a position unset.
 */
export function slotMismatches(
  lineup: string[],
  template: LineupTemplate,
  positions: Map<string, Position | undefined>,
): number[] {
  const out: number[] = []
  lineup.forEach((id, slot) => {
    const pos = positions.get(id)
    if (pos !== undefined && pos !== template[slot]) out.push(slot)
  })
  return out
}

/**
 * Which of the three paths applies to a single shift.
 *
 * - (a) no template -> the position-blind greedy, unchanged
 * - (b) EQUAL_TIME  -> the position-blind greedy; the coach said playtime wins
 * - (c) BALANCED and the template is unsatisfiable by the active roster -> fall back
 *
 * Rule (c) is **generation-time only**. It exists to avoid paying a mismatch penalty
 * on every shift for a template that can never be honored: measured on a 1G/3F/2C
 * roster under [G,G,F,F,C], BALANCED scored a playtime spread of 10 min where
 * EQUAL_TIME managed 5. But mid-game, an unsatisfiable template is a committed,
 * coach-owned situation — §6.6's injury sub is explicitly a coach-overridable break,
 * and the sideline coach outranks the plan. Silently discarding a stated intent for
 * every remaining shift is worse than showing a flagged, coach-overridable break.
 */
export function shouldUseSolver(
  activePlayerIds: string[],
  positions: Map<string, Position | undefined>,
  template: LineupTemplate | undefined,
  priority: LineupPriority,
  phase: 'create' | 'midgame',
): boolean {
  if (!template || template.length !== ON_COURT) return false
  if (priority === 'EQUAL_TIME') return false
  if (priority === 'BALANCED' && phase === 'create') {
    const d = templateDiagnostics(activePlayerIds, positions, template)
    if (!d.satisfiable) return false
  }
  return true
}

/**
 * Solve one shift. Returns the five player ids, ordered by slot.
 *
 * `W` is the mismatch penalty and collapses the three modes into one constant:
 * BALANCED uses `shiftDuration`, TEMPLATE uses BIG_M (delete mismatch edges).
 * An unsatisfiable template degrades to the closest achievable lineup rather than
 * failing, so a short roster still gets five valid players.
 */
export function solveShift(
  activePlayerIds: string[],
  timeline: Map<string, TimelineLike>,
  template: LineupTemplate,
  positions: Map<string, Position | undefined>,
  shiftDuration: number,
  maxConsecutiveShifts: number,
  mismatchPenalty: number,
  tiebreaker?: Map<string, number>,
): string[] {
  const pool = activePlayerIds
  const playtimes = pool.map(id => timeline.get(id)?.totalPlaytime ?? 0)
  // maxPlaytime - minPlaytime + shiftDuration, across the active pool. Including a
  // literal 0 as a candidate would clamp the floor and inflate the penalty once
  // everyone has played, making rest dominate every other term.
  const restPenalty =
    playtimes.length > 0
      ? Math.max(...playtimes) - Math.min(...playtimes) + shiftDuration
      : shiftDuration

  const makeCost =
    (penalty: number) =>
    (playerIdx: number, slotIdx: number): number => {
      const id = pool[playerIdx]
      const tl = timeline.get(id)
      if (!tl) return BIG_M
      let c = tl.totalPlaytime
      if (tl.lastShiftPlayed) c += restPenalty
      if (tl.consecutivePlayed >= maxConsecutiveShifts) c += shiftDuration
      const pos = positions.get(id)
      if (pos !== undefined && pos !== template[slotIdx]) c += penalty
      // Tiebreaker as an epsilon, not a term of its own. Without it the solver is
      // deterministic on the cost values alone and "Re-shuffle" would return a
      // byte-identical plan for every template-active game. Every real cost above is a
      // whole number of minutes, so an epsilon bounded by (N-1) * TIEBREAK_EPSILON
      // cannot outweigh a genuine one-minute difference.
      if (tiebreaker) c += (tiebreaker.get(id) ?? 0) * TIEBREAK_EPSILON
      return c
    }

  const penalty = mismatchPenalty >= BIG_M ? BIG_M : mismatchPenalty
  let result = assign(makeCost(penalty), pool.length, ON_COURT)
  if (!result && penalty < BIG_M) {
    // Unsatisfiable under the intended penalty: fall back to a finite one so the
    // roster still gets five valid players, closest achievable to the template.
    result = assign(makeCost(DEGRADE_PENALTY), pool.length, ON_COURT)
  }
  if (!result) {
    // Fewer than 5 active players, or no assignment exists at any cost. Fall back to
    // the same greedy the position-blind path uses so this can never return < 5
    // players for a roster that the greedy can seat.
    return pickLineupFallback(pool, timeline, maxConsecutiveShifts, tiebreaker)
  }

  // Ties are broken inside the cost function by the tiebreaker rank (see
  // `TIEBREAK_EPSILON`), so the returned lineup is a pure function of the inputs and
  // the ordering is the solver's slot order, not an incidental array order.
  return result.chosen.map(idx => pool[idx])
}

/** The greedy's selection rule, used only as a last-resort floor. Mirrors `pickLineup`. */
function pickLineupFallback(
  activePlayerIds: string[],
  timeline: Map<string, TimelineLike>,
  maxConsecutiveShifts: number,
  tiebreaker?: Map<string, number>,
): string[] {
  const sorted = [...activePlayerIds].sort((a, b) => {
    const ta = timeline.get(a)
    const tb = timeline.get(b)
    if (!ta || !tb) return a < b ? -1 : 1
    if (ta.lastShiftPlayed !== tb.lastShiftPlayed) return ta.lastShiftPlayed ? 1 : -1
    if (ta.totalPlaytime !== tb.totalPlaytime) return ta.totalPlaytime - tb.totalPlaytime
    if (tiebreaker) return (tiebreaker.get(a) ?? 0) - (tiebreaker.get(b) ?? 0)
    return a < b ? -1 : 1
  })

  const lineup: string[] = []
  const skipped: string[] = []
  for (const pid of sorted) {
    if (lineup.length >= ON_COURT) break
    const tl = timeline.get(pid)
    if (tl && tl.lastShiftPlayed && tl.consecutivePlayed >= maxConsecutiveShifts) {
      skipped.push(pid)
      continue
    }
    lineup.push(pid)
  }
  for (const pid of skipped) {
    if (lineup.length >= ON_COURT) break
    lineup.push(pid)
  }
  return lineup
}

/** Advance the timeline after a shift, exactly as the greedy does. */
export function applyShiftToTimeline(
  timeline: Map<string, TimelineLike>,
  lineup: string[],
  shiftDuration: number,
): void {
  const set = new Set(lineup)
  for (const [id, tl] of timeline) {
    if (set.has(id)) {
      tl.totalPlaytime += shiftDuration
      tl.consecutivePlayed++
      tl.lastShiftPlayed = true
    } else {
      tl.consecutivePlayed = 0
      tl.lastShiftPlayed = false
    }
  }
}

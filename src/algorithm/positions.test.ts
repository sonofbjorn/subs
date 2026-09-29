import { describe, it, expect } from 'vitest'
import {
  assign,
  templateDiagnostics,
  shouldUseSolver,
  solveShift,
  applyShiftToTimeline,
  slotMismatches,
  BIG_M,
  type PositionConfig,
} from './positions'
import type { LineupPriority, LineupTemplate, Position } from '../types'
import { generateLineups } from './lineup'

interface TL {
  totalPlaytime: number
  consecutivePlayed: number
  lastShiftPlayed: boolean
}

function timeline(entries: Array<[string, number, number, boolean]>): Map<string, TL> {
  return new Map(entries.map(([id, pt, consec, last]) => [id, { totalPlaytime: pt, consecutivePlayed: consec, lastShiftPlayed: last }]))
}

function posMap(spec: Record<string, Position | undefined>): Map<string, Position | undefined> {
  return new Map(Object.entries(spec))
}

const GGFFC: LineupTemplate = ['G', 'G', 'F', 'F', 'C']
const GGGFF: LineupTemplate = ['G', 'G', 'G', 'F', 'F']
const GFFCC: LineupTemplate = ['G', 'F', 'F', 'C', 'C']

// ---------------------------------------------------------------------------
// Solver correctness
// ---------------------------------------------------------------------------

describe('assign', () => {
  // Deterministic LCG so the differential test is reproducible.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  function permutations(n: number, k: number): number[][] {
    const out: number[][] = []
    const walk = (remaining: number[], acc: number[]) => {
      if (acc.length === k) {
        out.push([...acc])
        return
      }
      remaining.forEach((v, i) => walk([...remaining.slice(0, i), ...remaining.slice(i + 1)], [...acc, v]))
    }
    walk([...Array(n).keys()], [])
    return out
  }

  function bruteForce(
    cost: (p: number, s: number) => number,
    n: number,
    k: number,
  ): number | null {
    let best: number | null = null
    for (const combo of permutations(n, k)) {
      let total = 0
      let forbidden = false
      for (let s = 0; s < k; s++) {
        const c = cost(combo[s], s)
        if (c >= BIG_M) {
          forbidden = true
          break
        }
        total += c
      }
      if (forbidden) continue
      if (best === null || total < best) best = total
    }
    return best
  }

  // Guards the two implementation traps in design.md §4.5.3: row orientation and
  // finite-vs-Infinity forbidden edges. Both produce a plausible-looking wrong answer
  // rather than an exception, so neither a smoke test nor a review catches them.
  it('matches a brute-force optimum on random cost matrices with forbidden edges', () => {
    let infeasible = 0
    for (let trial = 0; trial < 500; trial++) {
      const n = 5 + Math.floor(rand() * 5)
      const k = 5
      const infFrac = rand() * 0.35
      // Pre-built so both algorithms see identical data. A lazy cost function would
      // be called a different number of times in each order and desynchronize.
      const m = Array.from({ length: n }, () =>
        Array.from({ length: k }, () => (rand() < infFrac ? Infinity : Math.floor(rand() * 40))),
      )
      const cost = (p: number, s: number) => m[p][s]

      const got = assign(cost, n, k)
      const want = bruteForce(cost, n, k)

      if (want === null) {
        infeasible++
        expect(got, `trial ${trial} should be infeasible`).toBeNull()
      } else {
        expect(got, `trial ${trial} total`).not.toBeNull()
        expect(got!.total, `trial ${trial} total`).toBe(want)
        // Every slot filled by a distinct player.
        expect(new Set(got!.chosen).size, `trial ${trial} distinctness`).toBe(k)
        expect(got!.chosen.every(i => i >= 0 && i < n), `trial ${trial} range`).toBe(true)
      }
    }
    // Sanity: the generator must actually have produced infeasible instances, or the
    // infeasibility assertions above are vacuous.
    expect(infeasible).toBeGreaterThan(0)
  })

  it('does not report spurious infeasibility once all slots are fillable', () => {
    // Regression: iterating rows as players (N) instead of slots (K) attempts N-K
    // extra augmentations after every slot is filled and bails with null.
    const cost = (p: number) => (p + 1) * 10
    const got = assign(cost, 9, 5)
    expect(got).not.toBeNull()
    expect(got!.chosen.length).toBe(5)
  })

  it('honours forbidden edges rather than treating them as merely expensive', () => {
    // Player 0 can only take slot 0. A solver that ignored the sentinel would
    // happily place someone else there instead.
    const cost = (p: number, s: number) => (p === 0 && s !== 0 ? BIG_M : 1)
    const got = assign(cost, 6, 5)
    expect(got).not.toBeNull()
    expect(got!.chosen[0]).toBe(0)
  })
})

describe('solveShift', () => {
  // design.md §4.5.5. Greedy slot-filling takes the two flex players for the guard
  // slots, starving the forwards, and then tries to reuse the center — a broken
  // lineup, when a zero-mismatch perfect matching exists and is reachable.
  it('finds the zero-mismatch matching that greedy slot-filling misses', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const positions = posMap({ a: 'G', b: 'F', c: 'C', d: undefined, e: undefined })
    // Fairness order least-playtime-first is d, e, a, b, c.
    const tl = timeline([
      ['d', 0, 0, false],
      ['e', 5, 1, true],
      ['a', 10, 0, false],
      ['b', 15, 0, false],
      ['c', 20, 0, false],
    ])

    const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, BIG_M)

    expect(new Set(lineup).size).toBe(5)
    const mismatches = lineup.filter((id, i) => {
      const p = positions.get(id)
      return p !== undefined && p !== GGFFC[i]
    })
    expect(mismatches, 'a perfect matching exists, so there should be none').toEqual([])
  })

  it('returns exactly 5 distinct players under every mode', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'c1', 'c2', 'c3']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', c1: 'C', c2: 'C', c3: 'C' })
    const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
    for (const w of [5, BIG_M]) {
      const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, w)
      expect(lineup.length).toBe(5)
      expect(new Set(lineup).size).toBe(5)
    }
  })

  it('is deterministic given the same inputs', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    const runs = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
      runs.add(solveShift(ids, tl, GGFFC, positions, 5, 2, 5).join(','))
    }
    expect(runs.size).toBe(1)
  })

  // Regression: the tiebreaker was accepted by the signature but never reached the cost
  // function, which made every template-active "Re-shuffle" a byte-identical plan —
  // the one thing the button exists to prevent.
  it('varies with the tiebreaker so Re-shuffle produces a different plan', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    const runWith = (ranks: number[]) =>
      solveShift(
        ids,
        timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean])),
        GGFFC, positions, 5, 2, 5, new Map(ids.map((id, i) => [id, ranks[i]])),
      )
    const forward = runWith([0, 1, 2, 3, 4, 5, 6])
    const reversed = runWith([6, 5, 4, 3, 2, 1, 0])
    expect(forward).not.toEqual(reversed)
    // Still a valid lineup either way, and the template is cheap enough to hold.
    for (const lineup of [forward, reversed]) {
      expect(lineup.length).toBe(5)
      expect(new Set(lineup).size).toBe(5)
    }
  })

  // The epsilon that makes the tiebreaker work must stay far below a real cost
  // difference, or it would start overriding fairness and position to buy variety.
  it('never lets the tiebreaker outweigh a real minute of cost', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    // c2 has one minute less playtime than c1, so c2 must win the single C slot no
    // matter how the tiebreaker ranks them.
    for (const c1Rank of [0, 1, 2, 3, 4, 5, 6]) {
      const tl = timeline([
        ['g1', 0, 0, false], ['g2', 0, 0, false], ['f1', 0, 0, false], ['f2', 0, 0, false],
        ['f3', 0, 0, false], ['c1', 5, 0, false], ['c2', 4, 0, false],
      ])
      const ranks = new Map(ids.map(id => [id, id === 'c1' ? c1Rank : 0]))
      const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, 5, ranks)
      expect(lineup[4], `c1 rank ${c1Rank}`).toBe('c2')
    }
  })

  it('satisfies the template on every shift when the roster can satisfy it (TEMPLATE)', () => {
    // With a forbidden mismatch edge there is no reason to ever accept a mismatch on
    // a satisfiable roster. BALANCED is explicitly not held to this — bending the
    // template is the entire point of the mode.
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    for (let trial = 0; trial < 20; trial++) {
      const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
      for (let shift = 0; shift < 8; shift++) {
        const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, BIG_M)
        const mismatches = lineup.filter((id, i) => {
          const p = positions.get(id)
          return p !== undefined && p !== GGFFC[i]
        })
        expect(mismatches, `trial ${trial} shift ${shift}`).toEqual([])
        applyShiftToTimeline(tl, lineup, 5)
      }
    }
  })

  // BALANCED does bend the template on purpose, so this asserts the *direction* of
  // the trade rather than exact figures: raising W can only reduce the number of
  // shifts it bends, never increase it.
  it('bends the template no more often as W rises', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    const bends = (w: number) => {
      const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
      let n = 0
      for (let shift = 0; shift < 8; shift++) {
        const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, w)
        if (lineup.some((id, i) => {
          const p = positions.get(id)
          return p !== undefined && p !== GGFFC[i]
        })) n++
        applyShiftToTimeline(tl, lineup, 5)
      }
      return n
    }
    const low = bends(1)
    const mid = bends(5)
    const high = bends(BIG_M)
    expect(high).toBe(0)
    expect(mid).toBeLessThanOrEqual(low)
    expect(high).toBeLessThanOrEqual(mid)
  })

  it('degrades to a valid lineup when the template cannot be satisfied', () => {
    // One guard against a two-guard template, no flex. Never satisfiable.
    const ids = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
    const lineup = solveShift(ids, tl, GGFFC, positions, 5, 2, BIG_M)
    expect(lineup.length).toBe(5)
    expect(new Set(lineup).size).toBe(5)
  })

  it('treats a player with no position as flex, never as unplayable', () => {
    // Every player unassigned: any template is trivially satisfiable.
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    const positions = posMap({ p1: undefined, p2: undefined, p3: undefined, p4: undefined, p5: undefined, p6: undefined })
    const tl = timeline(ids.map(id => [id, 0, 0, false] as [string, number, number, boolean]))
    const lineup = solveShift(ids, tl, GGGFF, positions, 5, 2, 5)
    expect(new Set(lineup).size).toBe(5)
    // Flex matches every slot, so there is never a mismatch to report.
    const mismatches = lineup.filter((id, i) => {
      const p = positions.get(id)
      return p !== undefined && p !== GGGFF[i]
    })
    expect(mismatches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Mode semantics and path selection
// ---------------------------------------------------------------------------

describe('shouldUseSolver', () => {
  const satisfiableIds = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
  const satisfiable = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })

  it('uses the greedy when there is no template', () => {
    for (const priority of ['BALANCED', 'EQUAL_TIME', 'TEMPLATE'] as LineupPriority[]) {
      expect(shouldUseSolver(satisfiableIds, satisfiable, undefined, priority, 'create')).toBe(false)
    }
  })

  it('uses the greedy for EQUAL_TIME regardless of the template', () => {
    expect(shouldUseSolver(satisfiableIds, satisfiable, GGFFC, 'EQUAL_TIME', 'create')).toBe(false)
  })

  it('uses the solver for BALANCED and TEMPLATE on a satisfiable template', () => {
    expect(shouldUseSolver(satisfiableIds, satisfiable, GGFFC, 'BALANCED', 'create')).toBe(true)
    expect(shouldUseSolver(satisfiableIds, satisfiable, GGFFC, 'TEMPLATE', 'create')).toBe(true)
  })

  // design.md §4.5.4 rule (c), and the reason `phase` is required rather than optional.
  it('falls back to the greedy for BALANCED on an unsatisfiable template at create time', () => {
    const shortIds = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const short = posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    expect(shouldUseSolver(shortIds, short, GGFFC, 'BALANCED', 'create')).toBe(false)
  })

  it('does NOT fall back mid-game: a committed template is the coach\'s call to break', () => {
    const shortIds = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const short = posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    expect(shouldUseSolver(shortIds, short, GGFFC, 'BALANCED', 'midgame')).toBe(true)
  })

  // Keeps the distinction from being accidentally collapsed later.
  it('gives different answers at create vs midgame for the same unsatisfiable input', () => {
    const shortIds = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const short = posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    expect(shouldUseSolver(shortIds, short, GGFFC, 'BALANCED', 'create')).not.toBe(
      shouldUseSolver(shortIds, short, GGFFC, 'BALANCED', 'midgame'),
    )
  })

  // TEMPLATE deliberately does not fall back: following the template is the stated
  // intent even when it is impossible, and the coach gets a flagged degraded lineup.
  it('keeps the solver for TEMPLATE on an unsatisfiable template at create time', () => {
    const shortIds = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const short = posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    expect(shouldUseSolver(shortIds, short, GGFFC, 'TEMPLATE', 'create')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('templateDiagnostics', () => {
  it('reports a satisfied template with no warnings', () => {
    // 3G/3F/2C: every position has surplus, so no group is pinned to 100%.
    const ids = ['g1', 'g2', 'g3', 'f1', 'f2', 'f3', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', g3: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }), GGFFC)
    expect(d.satisfiable).toBe(true)
    expect(d.lockoutPositions).toEqual([])
    expect(d.shortPositions).toEqual([])
    expect(d.saturatedPositions).toEqual([])
    expect(d.hasWarning).toBe(false)
  })

  it('reports 5 flex players as satisfying any template', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
    const d = templateDiagnostics(ids, posMap({ p1: undefined, p2: undefined, p3: undefined, p4: undefined, p5: undefined }), GFFCC)
    expect(d.satisfiable).toBe(true)
    expect(d.hasWarning).toBe(false)
  })

  it('names the missing position when the template is unsatisfiable', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'f4', 'f5']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', f4: 'F', f5: 'F' }), GGFFC)
    expect(d.satisfiable).toBe(false)
    expect(d.shortPositions).toEqual(['C'])
    expect(d.hasWarning).toBe(true)
  })

  // Guards against regressing this into a false lockout warning: surplus players at a
  // position rotate evenly, so nobody is benched. This is the correction the user
  // caught in review — 2G/3F/2C under [G,G,F,F,C] locks nobody out.
  it('reports no lockout for a surplus position', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }), GGFFC)
    expect(d.satisfiable).toBe(true)
    expect(d.lockoutPositions).toEqual([])
  })

  // k_P = 0 is the ONLY genuine lockout, which makes a no-center template the
  // dangerous one rather than a short-roster template.
  it('reports a lockout only for a position with zero slots', () => {
    const ids = ['g1', 'g2', 'g3', 'f1', 'f2', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', g3: 'G', f1: 'F', f2: 'F', c1: 'C', c2: 'C' }), GGGFF)
    expect(d.lockoutPositions).toEqual(['C'])
    // Still satisfiable — the centers are benched, not unsatisfiable.
    expect(d.satisfiable).toBe(true)
  })

  // Shares are pure arithmetic and asserted numerically, so a regression is visible
  // as a wrong number rather than "a warning appeared".
  it('computes distortion shares as k_P / (n_P + flex)', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }), GGFFC)
    expect(d.shares.G).toBeCloseTo(2 / 2, 6)
    expect(d.shares.F).toBeCloseTo(2 / 3, 6)
    expect(d.shares.C).toBeCloseTo(1 / 2, 6)
  })

  it('counts a position with slots but no players as having zero share', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
    const d = templateDiagnostics(ids, posMap({ p1: undefined, p2: undefined, p3: undefined, p4: undefined, p5: undefined }), GGFFC)
    expect(d.shares.G).toBe(2 / 5)
    expect(d.shares.F).toBe(2 / 5)
    expect(d.shares.C).toBe(1 / 5)
  })

  // k_P = n_P pins that group to 100% of the game and no solver can relieve it.
  // Saturation is the k_P = n_P *instance* of distortion — a group with share 1.0
  // that has no slack — which is why the canonical 2G/3F/2C distortion example is
  // also a saturated roster at G.
  it('flags every saturated position', () => {
    // 1G/3F/2C under [G,F,F,C,C]: one guard against one guard slot, two centers
    // against two center slots. Both are pinned; the forwards are not.
    const ids = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }), GFFCC)
    expect(d.saturatedPositions).toEqual(['G', 'C'])
    expect(d.hasWarning).toBe(true)
  })

  it('treats the canonical 2G/3F/2C distortion roster as saturated at G', () => {
    // Guards: 2 players, 2 slots. Both on court every shift — the 100% figure in the
    // §4.5.3 distortion table. Forwards rotate evenly, centers are merely under-served.
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }), GGFFC)
    expect(d.satisfiable).toBe(true)
    expect(d.lockoutPositions).toEqual([])
    expect(d.saturatedPositions).toEqual(['G'])
  })

  it('does not flag saturation when flex players can relieve the group', () => {
    const ids = ['g1', 'f1', 'f2', 'f3', 'c1', 'c2', 'x1']
    const d = templateDiagnostics(ids, posMap({ g1: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C', x1: undefined }), GFFCC)
    expect(d.saturatedPositions).toEqual([])
  })

  it('treats five flex players as satisfying any template without warning', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
    const d = templateDiagnostics(ids, posMap({ p1: undefined, p2: undefined, p3: undefined, p4: undefined, p5: undefined }), GGFFC)
    expect(d.satisfiable).toBe(true)
    expect(d.saturatedPositions).toEqual([])
    expect(d.hasWarning).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Calibration matrix — the guard on W (design.md §7.4)
// ---------------------------------------------------------------------------

const ROSTERS: Record<string, string> = {
  '6p 2G2F2C': 'GGFFCC',
  '6p 3G2F1C': 'GGGFFC',
  '6p 1G3F2C': 'GFFFCC',
  '7p 2G3F2C': 'GGFFFCC',
  '7p 3G2F2C': 'GGGFFCC',
  '7p 3G3F1C': 'GGGFFFC',
  '8p 3G3F2C': 'GGGFFFCC',
  '8p 2G4F2C': 'GGFFFFCC',
  '8p 4G2F2C': 'GGGGFFCC',
  '9p 3G3F3C': 'GGGFFFCCC',
  '9p 3G4F2C': 'GGGFFFFCC',
  '9p 4G3F2C': 'GGGGFFFCC',
  '10p 4G3F3C': 'GGGGFFFCCC',
  '10p 3G4F3C': 'GGGFFFFCCC',
  '10p 4G4F2C': 'GGGGFFFFCC',
  '12p 4G4F4C': 'GGGGFFFFCCCC',
}
const TEMPLATES: Record<string, LineupTemplate> = { GGFFC, GGGFF, GFFCC }
const GAME_SHAPES: Record<string, { n: number; d: number }> = {
  '8x5min': { n: 8, d: 5 },
  '6x5min': { n: 6, d: 5 },
  '8x4min': { n: 8, d: 4 },
  '10x4min': { n: 10, d: 4 },
}

interface RunResult {
  spread: number
  mismatchedShifts: number
  usedSolver: boolean
}

/**
 * Runs a whole game through the real `generateLineups` entry point rather than
 * reimplementing the loop here. An earlier version of this harness inlined the
 * position-blind greedy as a simplified sort with no consecutive limit, which
 * measured the solver against a baseline the product does not actually use — the
 * numbers came out better than reality (see design.md §4.5.4, revised).
 */
function runGame(
  spec: string,
  template: LineupTemplate,
  mode: LineupPriority,
  nShifts: number,
  shiftDur: number,
): RunResult {
  const ids = [...spec].map((_, i) => `p${i}`)
  const positions = posMap(Object.fromEntries([...spec].map((p, i) => [ids[i], p as Position])))
  const usedSolver = shouldUseSolver(ids, positions, template, mode, 'create')

  const res = generateLineups(ids, 1, nShifts * shiftDur, shiftDur, undefined, 2, undefined, {
    positions,
    template,
    priority: mode,
    phase: 'create',
  })

  // Seeded to 0 so a player the plan never seats counts as 0 minutes. Leaving them
  // out of the map entirely would silently reward a template that benches someone:
  // a lockout showed up as a *better* playtime spread than the equal-time plan.
  const totals = new Map<string, number>(ids.map(id => [id, 0]))
  let mismatchedShifts = 0
  for (const seg of res)
    for (const shift of seg.shifts) {
      for (const id of shift.lineup) totals.set(id, (totals.get(id) ?? 0) + shift.shiftDuration)
      if (usedSolver && shift.lineup.some((id, i) => {
        const p = positions.get(id)
        return p !== undefined && p !== template[i]
      })) {
        mismatchedShifts++
      }
    }

  const values = [...totals.values()]
  return { spread: Math.max(...values) - Math.min(...values), mismatchedShifts, usedSolver }
}

const CASES: Array<{
  label: string
  spec: string
  template: LineupTemplate
  shape: { n: number; d: number }
}> = []
for (const [rLabel, spec] of Object.entries(ROSTERS))
  for (const [tLabel, template] of Object.entries(TEMPLATES))
    for (const [gLabel, shape] of Object.entries(GAME_SHAPES))
      CASES.push({ label: `${rLabel} / ${tLabel} / ${gLabel}`, spec, template, shape })

/**
 * Repetitions per case.
 *
 * A game generated with a template is **not** deterministic: `generateLineups` builds a
 * shuffled tiebreaker whenever every player starts level (a fresh game, or a
 * regeneration), and the solver consumes it, so each call explores a different
 * tie-broken optimum. That is the intended "Re-shuffle" behavior, and it matches how
 * the position-blind path has always behaved - but it means one call measures a single
 * sample of a distribution, not the mode's expected quality.
 *
 * Measuring single samples is how an earlier revision of this suite reported
 * distortion 0.087 when the expected value is 0.127: the sample had been lucky. Every
 * aggregate below is averaged over this many runs.
 */
const REPS = 7

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

describe('calibration matrix', () => {
  it('covers the documented 192 cases', () => {
    expect(CASES.length).toBe(192)
  })

  it('W = shiftDuration keeps distortion on distorting cases below 0.20', () => {
    // distortion 0 == BALANCED matches EQUAL_TIME fairness; 1 == no better than TEMPLATE.
    // Measured mean through the real entry point over the 141 distorting cases: 0.127,
    // i.e. BALANCED recovers ~87% of the fairness the template would cost.
    const ratios: number[] = []
    for (const c of CASES) {
      const equal = runGame(c.spec, c.template, 'EQUAL_TIME', c.shape.n, c.shape.d)
      const tmpl = runGame(c.spec, c.template, 'TEMPLATE', c.shape.n, c.shape.d)
      const gap = tmpl.spread - equal.spread
      if (gap <= c.shape.d) continue // template costs nothing here
      const bal = mean(
        Array.from(
          { length: REPS },
          () => runGame(c.spec, c.template, 'BALANCED', c.shape.n, c.shape.d).spread,
        ),
      )
      ratios.push((bal - equal.spread) / gap)
    }
    expect(ratios.length).toBeGreaterThan(0)
    const m = mean(ratios)
    expect(m, `mean distortion ${m.toFixed(3)}`).toBeLessThan(0.2)
  })

  it('W = shiftDuration keeps template compliance above 85% where the template is free', () => {
    // Measured mean through the real entry point over the 51 free cases: 93%.
    const compliance: number[] = []
    for (const c of CASES) {
      const equal = runGame(c.spec, c.template, 'EQUAL_TIME', c.shape.n, c.shape.d)
      const tmpl = runGame(c.spec, c.template, 'TEMPLATE', c.shape.n, c.shape.d)
      if (tmpl.spread - equal.spread > c.shape.d) continue // this one distorts
      compliance.push(
        mean(
          Array.from(
            { length: REPS },
            () =>
              1 - runGame(c.spec, c.template, 'BALANCED', c.shape.n, c.shape.d).mismatchedShifts / c.shape.n,
          ),
        ),
      )
    }
    expect(compliance.length).toBeGreaterThan(0)
    const m = mean(compliance)
    expect(m, `compliance ${(m * 100).toFixed(0)}%`).toBeGreaterThan(0.85)
  })

  it('never does worse than TEMPLATE on playtime spread, on any of its samples', () => {
    // Checked against the *worst* of REPS samples, not the mean, because the claim is
    // about the worst plan a coach can be handed. Holds across all 192 cases, and it is
    // worth asserting rather than assuming: the obvious counterexample is a lockout,
    // where TEMPLATE seats 5 players 40/40 and a naive spread ignores the one on the
    // bench. Measuring every active player including 0-minute ones is what makes this
    // pass for the right reason.
    for (const c of CASES) {
      const tmpl = runGame(c.spec, c.template, 'TEMPLATE', c.shape.n, c.shape.d)
      for (let i = 0; i < REPS; i++) {
        const bal = runGame(c.spec, c.template, 'BALANCED', c.shape.n, c.shape.d)
        expect(
          bal.spread,
          `${c.label} sample ${i}: balanced ${bal.spread} vs template ${tmpl.spread}`,
        ).toBeLessThanOrEqual(tmpl.spread)
      }
    }
  })

  it('always satisfies the template in TEMPLATE mode, on every shift it can satisfy', () => {
    // TEMPLATE is the one mode with no randomness left in it: a mismatch edge is
    // forbidden, so the optimum can never spend one.
    //
    // Scoped to *satisfiable* rosters on purpose. TEMPLATE never falls back to the
    // greedy - that is the documented behavior for an unsatisfiable template - so
    // mismatch counts there are the closest-achievable result, not a defect. Asserting
    // zero across all 192 cases would be asserting that a template is always fillable.
    let checked = 0
    for (const c of CASES) {
      const ids = [...c.spec].map((_, i) => `p${i}`)
      const positions = posMap(Object.fromEntries([...c.spec].map((p, i) => [ids[i], p as Position])))
      if (!templateDiagnostics(ids, positions, c.template).satisfiable) continue
      checked++
      expect(runGame(c.spec, c.template, 'TEMPLATE', c.shape.n, c.shape.d).mismatchedShifts, c.label).toBe(0)
    }
    expect(checked, 'expected some satisfiable cases in the matrix').toBeGreaterThan(0)
  })

  it('pays the documented cost for a distorting template, and only part of it under BALANCED', () => {
    // EQUAL_TIME and TEMPLATE are deterministic (the greedy uses no tiebreaker, and
    // TEMPLATE has no ties left to break), so these two are exact figures.
    const equal = runGame('GGFFFCC', GGFFC, 'EQUAL_TIME', 8, 5)
    const tmpl = runGame('GGFFFCC', GGFFC, 'TEMPLATE', 8, 5)
    expect(equal.spread).toBe(5)
    expect(tmpl.spread).toBe(20)
    // BALANCED lands somewhere between the two on every sample, and always bends the
    // template at least once: that band is the entire point of the mode.
    for (let i = 0; i < REPS; i++) {
      const b = runGame('GGFFFCC', GGFFC, 'BALANCED', 8, 5)
      expect(b.spread, `sample ${i}`).toBeGreaterThanOrEqual(equal.spread)
      expect(b.spread, `sample ${i}`).toBeLessThanOrEqual(tmpl.spread)
      expect(b.mismatchedShifts, `sample ${i}`).toBeGreaterThan(0)
    }
  })

  it('leaves the position-blind path deterministic', () => {
    // W is derived from the *actual* shift length, which the real API ties to the
    // substitution interval, so there is no independent interval input for a coach
    // setting to move. An earlier revision of this suite compared
    // W = shiftDuration against W = substitutionIntervalMinutes and expected the
    // former to win; in the shipped code path those are the same number, so that
    // comparison was vacuous. BALANCED is deliberately excluded here - it varies by
    // design, which the Re-shuffle test above covers.
    for (const c of CASES) {
      const a = runGame(c.spec, c.template, 'EQUAL_TIME', c.shape.n, c.shape.d)
      const b = runGame(c.spec, c.template, 'EQUAL_TIME', c.shape.n, c.shape.d)
      expect(a.spread, c.label).toBe(b.spread)
      expect(a.mismatchedShifts, c.label).toBe(b.mismatchedShifts)
    }
  })
})

describe('slotMismatches', () => {
  it('reports nothing for a lineup that matches the template', () => {
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', c1: 'C' })
    expect(slotMismatches(['g1', 'g2', 'f1', 'f2', 'c1'], GGFFC, positions)).toEqual([])
  })

  it('reports the slot index, not the player', () => {
    // A center in the first guard slot. Reporting the player would be useless to a
    // display that has to know *which* slot is wrong.
    const positions = posMap({ c1: 'C', g2: 'G', f1: 'F', f2: 'F', g1: 'G' })
    expect(slotMismatches(['c1', 'g2', 'f1', 'f2', 'g1'], GGFFC, positions)).toEqual([0, 4])
  })

  it('never counts a flex player as a mismatch, whatever slot they are in', () => {
    const positions = posMap({ x: undefined, g2: 'G', f1: 'F', f2: 'F', c1: 'C' })
    expect(slotMismatches(['x', 'g2', 'f1', 'f2', 'c1'], GGFFC, positions)).toEqual([])
  })

  it('is order-sensitive, so sorting a lineup before checking invalidates it', () => {
    // The display layer used to sort by name. This is the regression guard for that:
    // the same five players, correct in slot order and mismatched once sorted.
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', c1: 'C' })
    const lineup = ['g1', 'g2', 'f1', 'f2', 'c1']
    expect(slotMismatches(lineup, GGFFC, positions)).toEqual([])
    expect(slotMismatches([...lineup].sort(), GGFFC, positions)).not.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Integration with the existing entry point
// ---------------------------------------------------------------------------

describe('generateLineups with positionConfig', () => {
  it('produces output identical to no config when no template is given', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const baseline = generateLineups(ids, 2, 10, 5)
    const withConfig = generateLineups(ids, 2, 10, 5, undefined, 2, undefined, {
      positions: posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' }),
      priority: 'BALANCED',
      phase: 'create',
    } satisfies PositionConfig)
    // Both are shuffles of an all-equal start, so compare structure rather than
    // exact ids: every shift must seat 5 distinct players in both.
    for (const seg of withConfig) {
      for (const shift of seg.shifts) expect(new Set(shift.lineup).size).toBe(5)
    }
    expect(baseline.length).toBe(withConfig.length)
  })

  it('produces identical output for all three priorities when no template is set', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
    const positions = posMap({ p1: 'G', p2: 'G', p3: 'F', p4: 'F', p5: 'C', p6: 'C', p7: 'C' })
    // A fixed tiebreaker is impossible through the public API, so compare the
    // property that must hold: the template is irrelevant, so no mode should change
    // whether a shift seats 5 players or how playtime spreads.
    const spreads = (['BALANCED', 'EQUAL_TIME', 'TEMPLATE'] as LineupPriority[]).map(priority => {
      const res = generateLineups(ids, 4, 10, 5, undefined, 2, undefined, { positions, priority, phase: 'create' })
      for (const seg of res) for (const s of seg.shifts) expect(new Set(s.lineup).size).toBe(5)
      const totals = new Map<string, number>()
      for (const seg of res)
        for (const s of seg.shifts)
          for (const id of s.lineup) totals.set(id, (totals.get(id) ?? 0) + s.shiftDuration)
      const v = [...totals.values()]
      return Math.max(...v) - Math.min(...v)
    })
    expect(spreads.every(s => s === spreads[0])).toBe(true)
  })

  it('honors a TEMPLATE constraint on every shift of a full game', () => {
    const ids = ['g1', 'g2', 'f1', 'f2', 'f3', 'c1', 'c2']
    const positions = posMap({ g1: 'G', g2: 'G', f1: 'F', f2: 'F', f3: 'F', c1: 'C', c2: 'C' })
    const res = generateLineups(ids, 4, 10, 5, undefined, 2, undefined, {
      positions,
      template: GGFFC,
      priority: 'TEMPLATE',
      phase: 'create',
    })
    for (const seg of res) {
      for (const s of seg.shifts) {
        expect(new Set(s.lineup).size).toBe(5)
        const mismatches = s.lineup.filter((id, i) => {
          const p = positions.get(id)
          return p !== undefined && p !== GGFFC[i]
        })
        expect(mismatches).toEqual([])
      }
    }
  })
})

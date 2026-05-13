import { describe, it, expect } from 'vitest'
import { generateLineups, calculatePlaytime } from './lineup'

function ids(...names: string[]): string[] {
  return names
}

function playtimeTotals(
  result: ReturnType<typeof generateLineups>,
): Map<string, number> {
  const pt = new Map<string, number>()
  for (const seg of result) {
    for (const shift of seg.shifts) {
      for (const pid of shift.lineup) {
        pt.set(pid, (pt.get(pid) ?? 0) + shift.shiftDuration)
      }
    }
  }
  return pt
}

function maxMinDiff(map: Map<string, number>): number {
  const vals = [...map.values()]
  return Math.max(...vals) - Math.min(...vals)
}

describe('generateLineups', () => {
  it('puts all 5 players on court in every shift when exactly 5 are available', () => {
    const players = ids('a', 'b', 'c', 'd', 'e')
    const result = generateLineups(players, 2, 10, 5)

    for (const seg of result) {
      for (const shift of seg.shifts) {
        expect(shift.lineup).toHaveLength(5)
        expect(shift.lineup.sort()).toEqual(players.sort())
      }
    }
  })

  it('produces correct number of shifts per segment', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f', 'g')
    const result = generateLineups(players, 2, 10, 5)

    expect(result).toHaveLength(2)
    for (const seg of result) {
      expect(seg.shifts).toHaveLength(2)
    }
  })

  it('handles partial last shift when interval does not divide evenly', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f')
    const result = generateLineups(players, 1, 8, 3)

    expect(result[0].shifts).toHaveLength(3)
    expect(result[0].shifts[2].shiftDuration).toBe(2)
  })

  it('distributes playtime evenly for 7 players over many shifts', () => {
    const players = ids('p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7')
    const result = generateLineups(players, 4, 20, 5)

    const pt = playtimeTotals(result)
    const diff = maxMinDiff(pt)

    // Round-robin should keep variance very low
    expect(diff).toBeLessThanOrEqual(5)
    expect(pt.size).toBe(7)
    for (const [, minutes] of pt) {
      expect(minutes).toBeGreaterThan(0)
    }
  })

  it('distributes playtime evenly for 10 players across many shifts', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
    const result = generateLineups(players, 4, 20, 5)

    const pt = playtimeTotals(result)
    const diff = maxMinDiff(pt)

    expect(diff).toBeLessThanOrEqual(5)
    expect(pt.size).toBe(10)
  })

  it('prioritizes players with less existing playtime', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f')
    const existing = new Map<string, number>([
      ['a', 20], ['b', 20], ['c', 20], ['d', 20], ['e', 20], ['f', 0],
    ])

    const result = generateLineups(players, 8, 10, 5, existing)
    const total = new Map(existing)
    for (const [pid, mins] of playtimeTotals(result)) {
      total.set(pid, (total.get(pid) ?? 0) + mins)
    }

    const diff = maxMinDiff(total)
    // With round-robin, the existing gap should be nearly closed
    expect(diff).toBeLessThanOrEqual(10)
  })

  it('enforces maxConsecutiveShifts limit as a soft bound', () => {
    // 10 players, 8 shifts — plenty of subs, should never exceed 2 consecutive
    const players = ids('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
    const result = generateLineups(players, 2, 20, 5, undefined, 2)

    // Track consecutive shifts played for each player
    const consecPlayed = new Map<string, number>()
    let violations = 0

    for (const seg of result) {
      for (const shift of seg.shifts) {
        for (const pid of shift.lineup) {
          const count = (consecPlayed.get(pid) ?? 0) + 1
          consecPlayed.set(pid, count)
          if (count > 2) violations++
        }
        for (const pid of consecPlayed.keys()) {
          if (!shift.lineup.includes(pid)) {
            consecPlayed.set(pid, 0)
          }
        }
      }
    }

    expect(violations).toBe(0)
  })

  it('still produces valid lineups with only 6 players and consecutive limit', () => {
    // With only 6 players, someone has to exceed the limit occasionally
    const players = ids('a', 'b', 'c', 'd', 'e', 'f')
    const result = generateLineups(players, 4, 20, 5, undefined, 2)

    for (const seg of result) {
      for (const shift of seg.shifts) {
        expect(shift.lineup).toHaveLength(5)
        for (const pid of shift.lineup) {
          expect(players).toContain(pid)
        }
      }
    }
  })
})

describe('calculatePlaytime', () => {
  it('sums playtime across all segments and shifts', () => {
    const lineups = [
      {
        segmentIndex: 0,
        shifts: [
          { lineup: ids('a', 'b', 'c', 'd', 'e'), shiftDuration: 5 },
          { lineup: ids('a', 'b', 'c', 'f', 'g'), shiftDuration: 5 },
        ],
      },
      {
        segmentIndex: 1,
        shifts: [
          { lineup: ids('a', 'b', 'd', 'e', 'f'), shiftDuration: 5 },
        ],
      },
    ]

    const pt = calculatePlaytime(lineups)
    expect(pt.get('a')).toBe(15)
    expect(pt.get('g')).toBe(5)
    expect(pt.get('c')).toBe(10)
  })

  it('incorporates existing playtime', () => {
    const existing = new Map([['a', 10], ['b', 5]])
    const lineups = [
      {
        segmentIndex: 0,
        shifts: [
          { lineup: ids('a', 'b'), shiftDuration: 5 },
        ],
      },
    ]

    const pt = calculatePlaytime(lineups, existing)
    expect(pt.get('a')).toBe(15)
    expect(pt.get('b')).toBe(10)
  })
})

describe('edge cases', () => {
  it('handles empty active player list', () => {
    const result = generateLineups([], 1, 10, 5)
    expect(result).toHaveLength(1)
    expect(result[0].shifts).toHaveLength(2)
    for (const shift of result[0].shifts) {
      expect(shift.lineup).toHaveLength(0)
    }
  })

  it('handles single player', () => {
    const result = generateLineups(ids('a'), 1, 10, 5)
    for (const seg of result) {
      for (const shift of seg.shifts) {
        expect(shift.lineup).toEqual(['a'])
      }
    }
  })

  it('handles zero-duration segment', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f')
    const result = generateLineups(players, 1, 0, 5)
    expect(result[0].shifts).toHaveLength(0)
  })

  it('handles single segment', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f')
    const result = generateLineups(players, 1, 10, 5)
    expect(result).toHaveLength(1)
    expect(result[0].shifts).toHaveLength(2)
  })

  it('handles many segments', () => {
    const players = ids('a', 'b', 'c', 'd', 'e', 'f', 'g')
    const result = generateLineups(players, 8, 10, 5)
    expect(result).toHaveLength(8)
    for (const seg of result) {
      expect(seg.shifts).toHaveLength(2)
    }
  })

  it('handles maxConsecutiveShifts=1 with enough players', () => {
    // With 10 players and limit=1, each player sits at least every other shift
    const players = ids('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j')
    const result = generateLineups(players, 2, 20, 5, undefined, 1)

    const consecPlayed = new Map<string, number>()
    let violations = 0

    for (const seg of result) {
      for (const shift of seg.shifts) {
        for (const pid of shift.lineup) {
          const count = (consecPlayed.get(pid) ?? 0) + 1
          consecPlayed.set(pid, count)
          if (count > 1) violations++
        }
        for (const pid of consecPlayed.keys()) {
          if (!shift.lineup.includes(pid)) {
            consecPlayed.set(pid, 0)
          }
        }
      }
    }

    expect(violations).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import { effectiveGameDate, sortByEffectiveDate, buildGameHistory } from './gameHistory'
import { gamePlaytime } from './playtime'
import type { Game, Segment } from '../types'

const at = (iso: string) => new Date(iso)

function game(partial: Partial<Game> & { id: string; createdAt: Date }): Game {
  return {
    teamId: 't1',
    name: partial.id,
    activePlayerIds: [],
    injuredPlayerIds: [],
    structure: 'HALVES',
    durationMinutes: 20,
    substitutionIntervalMinutes: 5,
    maxConsecutiveShifts: 2,
    status: 'DRAFT',
    ...partial,
  }
}

describe('effectiveGameDate', () => {
  it('prefers completedAt for a finished game', () => {
    const g = game({
      id: 'a',
      createdAt: at('2026-01-05T18:00:00'),
      startedAt: at('2026-01-10T18:00:00'),
      completedAt: at('2026-01-10T19:00:00'),
    })
    expect(effectiveGameDate(g)).toEqual(at('2026-01-10T19:00:00'))
  })

  it('falls back to startedAt for a game in progress', () => {
    const g = game({
      id: 'a',
      createdAt: at('2026-01-05T18:00:00'),
      startedAt: at('2026-01-10T18:00:00'),
      status: 'ACTIVE',
    })
    expect(effectiveGameDate(g)).toEqual(at('2026-01-10T18:00:00'))
  })

  it('falls back to createdAt for a draft that was never started', () => {
    const g = game({ id: 'a', createdAt: at('2026-01-05T18:00:00') })
    expect(effectiveGameDate(g)).toEqual(at('2026-01-05T18:00:00'))
  })

  it('does not fabricate a timestamp for a legacy game', () => {
    // A game written before these fields existed. Backfilling completedAt = createdAt
    // would be a lie in a durable field, indistinguishable from a real stamp later.
    const legacy = game({ id: 'a', createdAt: at('2026-01-05T18:00:00') })
    expect(legacy.completedAt).toBeUndefined()
    expect(legacy.startedAt).toBeUndefined()
    expect(effectiveGameDate(legacy)).toEqual(legacy.createdAt)
  })
})

describe('sortByEffectiveDate', () => {
  it('orders by effective date, not creation date', () => {
    // The case that motivates the whole fallback chain: planned Monday, played Saturday.
    // A createdAt sort puts the Friday game on top, which is wrong.
    const plannedEarlier = game({
      id: 'planned-earlier',
      createdAt: at('2026-01-05T18:00:00'),
      startedAt: at('2026-01-10T18:00:00'),
      completedAt: at('2026-01-10T19:00:00'),
    })
    const createdLater = game({
      id: 'created-later',
      createdAt: at('2026-01-09T18:00:00'),
      startedAt: at('2026-01-09T19:00:00'),
      completedAt: at('2026-01-09T20:00:00'),
    })
    const sorted = sortByEffectiveDate([plannedEarlier, createdLater])
    expect(sorted.map(g => g.id)).toEqual(['planned-earlier', 'created-later'])
  })

  it('puts an in-progress game ahead of a completed one that ended earlier', () => {
    const completed = game({
      id: 'done',
      createdAt: at('2026-01-01T18:00:00'),
      startedAt: at('2026-01-01T18:00:00'),
      completedAt: at('2026-01-01T19:00:00'),
      status: 'COMPLETED',
    })
    const inProgress = game({
      id: 'live',
      createdAt: at('2026-01-01T10:00:00'),
      startedAt: at('2026-01-01T20:00:00'),
      status: 'ACTIVE',
    })
    expect(sortByEffectiveDate([completed, inProgress]).map(g => g.id)).toEqual(['live', 'done'])
  })

  it('is a total order, so equal dates never reorder between renders', () => {
    const date = at('2026-01-01T18:00:00')
    const rows = [
      game({ id: 'b', createdAt: date }),
      game({ id: 'a', createdAt: date }),
      game({ id: 'c', createdAt: date }),
    ]
    const once = sortByEffectiveDate(rows).map(g => g.id)
    const twice = sortByEffectiveDate([...rows].reverse()).map(g => g.id)
    expect(once).toEqual(['a', 'b', 'c'])
    expect(twice).toEqual(once)
  })

  it('does not mutate its input', () => {
    const rows = [
      game({ id: 'old', createdAt: at('2026-01-01T18:00:00') }),
      game({ id: 'new', createdAt: at('2026-06-01T18:00:00') }),
    ]
    const before = rows.map(g => g.id)
    sortByEffectiveDate(rows)
    expect(rows.map(g => g.id)).toEqual(before)
  })
})

describe('buildGameHistory', () => {
  const segment = (gameId: string, number: number): Segment => ({
    id: `${gameId}-seg-${number}`,
    gameId,
    number,
    label: number === 1 ? 'H1' : 'H2',
    status: 'COMPLETED',
  })

  it('includes DRAFT games, which are otherwise unreachable', () => {
    // The regression guard for the defect this feature exists to fix. A completed-only
    // list fails this.
    const games = [
      game({ id: 'draft', createdAt: at('2026-01-01T18:00:00'), status: 'DRAFT' }),
      game({ id: 'done', createdAt: at('2026-01-02T18:00:00'), status: 'COMPLETED' }),
    ]
    const rows = buildGameHistory(games, new Map())
    expect(rows.map(r => r.game.status)).toEqual(['COMPLETED', 'DRAFT'])
    expect(rows.map(r => r.game.id).sort()).toEqual(['done', 'draft'])
  })

  it('counts segments per game', () => {
    const byGame = new Map<string, Segment[]>([
      ['halves', [segment('halves', 1), segment('halves', 2)]],
      ['quarters', [segment('quarters', 1), segment('quarters', 2), segment('quarters', 3), segment('quarters', 4)]],
    ])
    const rows = buildGameHistory(
      [
        game({ id: 'halves', createdAt: at('2026-01-01T18:00:00') }),
        game({ id: 'quarters', createdAt: at('2026-01-02T18:00:00') }),
      ],
      byGame,
    )
    const count = (id: string) => rows.find(r => r.game.id === id)!.segmentCount
    expect(count('quarters')).toBe(4)
    expect(count('halves')).toBe(2)
  })

  it('reports zero segments rather than dropping a game with none loaded', () => {
    const rows = buildGameHistory([game({ id: 'x', createdAt: at('2026-01-01T18:00:00') })], new Map())
    expect(rows[0].segmentCount).toBe(0)
  })
})

describe('gamePlaytime with a mid-shift substitution', () => {
  // The bug this fixes. `injurySub` rewrites the shift's lineup in place, so the sub-out
  // player is absent from the shift entirely — not misweighted, absent — and a split-blind
  // walk credits them 0 minutes and the sub-in player the full shift.
  const shifts = [{ startMinute: 0, endMinute: 5, lineupJson: JSON.stringify(['a', 'b', 'c', 'd', 'e']) }]
  const splits = [{ minute: 2.5, playerOutId: 'a', playerInId: 'f' }]

  it('splits the shift in half rather than crediting 0 and the full duration', () => {
    const { playtime } = gamePlaytime(shifts, splits, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(playtime.get('a')).toBe(2.5)
    expect(playtime.get('f')).toBe(2.5)
    expect(playtime.get('b')).toBe(5)
  })

  it('sums the played minutes of every player to the court minutes of the game', () => {
    // Five players on court for five minutes is 25 player-minutes regardless of who was
    // standing where. This is the invariant a split-blind walk violates.
    const { playtime, totalMinutes } = gamePlaytime(shifts, splits, ['a', 'b', 'c', 'd', 'e', 'f'])
    const summed = [...playtime.values()].reduce((n, m) => n + m, 0)
    expect(summed).toBe(totalMinutes * 5)
  })

  it('includes an active player who never got on court, at zero', () => {
    // Not tidiness: a player who never played is the most informative row in a summary.
    const { playtime, shiftsPlayed } = gamePlaytime(shifts, splits, ['a', 'b', 'c', 'd', 'e', 'f', 'bench'])
    expect(playtime.get('bench')).toBe(0)
    expect(shiftsPlayed.get('bench')).toBe(0)
  })

  it('does not count a zero-length appearance as a shift played', () => {
    // Subbed in and straight back out: in the lineup, but logged no time.
    const instant = [{ minute: 0, playerOutId: 'a', playerInId: 'f' }, { minute: 0, playerOutId: 'f', playerInId: 'g' }]
    const { playtime, shiftsPlayed } = gamePlaytime(shifts, instant, ['a', 'f', 'g'])
    expect(shiftsPlayed.get('f')).toBe(0)
    expect(playtime.get('f')).toBe(0)
  })

  it('counts a full shift for a player with no substitutions', () => {
    const { shiftsPlayed } = gamePlaytime(shifts, splits, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(shiftsPlayed.get('b')).toBe(1)
    // The sub-out player still appeared for half the shift, which is a shift played.
    expect(shiftsPlayed.get('a')).toBe(1)
  })

  it('sums totalMinutes over shifts actually played, not the configured maximum', () => {
    // A shortened final shift must not report a share over 100%. The old denominator was
    // segments * durationMinutes regardless of what was generated.
    const uneven = [
      { startMinute: 0, endMinute: 5, lineupJson: JSON.stringify(['a', 'b', 'c', 'd', 'e']) },
      { startMinute: 5, endMinute: 7, lineupJson: JSON.stringify(['a', 'b', 'c', 'd', 'e']) },
    ]
    const { playtime, totalMinutes } = gamePlaytime(uneven, [], ['a', 'b', 'c', 'd', 'e'])
    expect(totalMinutes).toBe(7)
    const shares = [...playtime.values()].map(m => m / totalMinutes)
    for (const share of shares) expect(share).toBeLessThanOrEqual(1)
  })

  it('ignores splits belonging to other games', () => {
    // The repository filters splits by shift id before calling. Asserting the tolerance
    // here documents that `shiftPlaytime` itself is scoped by minute range, not by game.
    const otherShift = [{ startMinute: 100, endMinute: 105, lineupJson: JSON.stringify(['a', 'b', 'c', 'd', 'e']) }]
    const { playtime } = gamePlaytime(otherShift, splits, ['a', 'b', 'c', 'd', 'e', 'f'])
    expect(playtime.get('a')).toBe(5)
    // The split is outside this shift's minute range, so the sub never happened here.
    // `f` is still present at 0 because they are on the active roster.
    expect(playtime.get('f')).toBe(0)
  })

  it('totals zero for a game with no shifts', () => {
    const { playtime, totalMinutes } = gamePlaytime([], [], ['a', 'b'])
    expect(totalMinutes).toBe(0)
    expect(playtime.get('a')).toBe(0)
  })
})

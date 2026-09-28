import { describe, it, expect } from 'vitest'
import { shiftPlaytime, splitMinuteFor } from './playtime'

describe('splitMinuteFor', () => {
  it('returns the true midpoint, without truncating odd-length shifts', () => {
    // Regression: Math.floor((start + end) / 2) gave 2 for a 0–5 shift, which is a
    // position, not a duration. The midpoint of 0–5 is 2.5.
    expect(splitMinuteFor(0, 5)).toBe(2.5)
    expect(splitMinuteFor(5, 10)).toBe(7.5)
    expect(splitMinuteFor(0, 4)).toBe(2)
  })

  it('scales with the shift position within the segment', () => {
    expect(splitMinuteFor(10, 15)).toBe(12.5)
    expect(splitMinuteFor(20, 30)).toBe(25)
  })
})

describe('shiftPlaytime without splits', () => {
  it('credits every player on court the full shift', () => {
    const pt = shiftPlaytime(0, 5, ['a', 'b', 'c', 'd', 'e'], [])
    expect(pt.get('a')).toBe(5)
    expect(pt.get('e')).toBe(5)
    expect(pt.size).toBe(5)
  })
})

describe('shiftPlaytime with a mid-shift substitution', () => {
  // The shift's stored lineup is the POST-sub one: 'a' is out, 'f' is in.
  const lineup = ['b', 'c', 'd', 'e', 'f']
  const splits = [{ minute: 2.5, playerOutId: 'a', playerInId: 'f' }]

  it('splits the shift evenly at the midpoint', () => {
    const pt = shiftPlaytime(0, 5, lineup, splits)
    expect(pt.get('a')).toBe(2.5)
    expect(pt.get('f')).toBe(2.5)
  })

  it('leaves the four untouched players with the full shift', () => {
    const pt = shiftPlaytime(0, 5, lineup, splits)
    for (const pid of ['b', 'c', 'd', 'e']) {
      expect(pt.get(pid)).toBe(5)
    }
  })

  it('credits the sub-in player even though they were not in the pre-sub lineup', () => {
    // Regression: injurySub read the lineup before swapping, so the playerInId
    // branch was unreachable and 'f' was credited 0 minutes.
    const pt = shiftPlaytime(0, 5, lineup, splits)
    expect(pt.get('f')).toBe(2.5)
    expect(pt.get('f')).toBeGreaterThan(0)
  })

  it('credits the sub-out player even though they are absent from the final lineup', () => {
    // Regression: updateActiveRoster read the lineup after swapping, so the
    // playerOutId branch was unreachable and 'a' kept the full shift.
    const pt = shiftPlaytime(0, 5, lineup, splits)
    expect(pt.get('a')).toBe(2.5)
    expect(pt.get('a')).toBeLessThan(5)
  })

  it('does not let a segment offset leak into the duration', () => {
    // Regression: the split position was spent directly as minutes, so an injury in
    // the third shift of a period credited 12 minutes in a 5-minute shift.
    const pt = shiftPlaytime(10, 15, lineup, splits)
    for (const mins of pt.values()) {
      expect(mins).toBeLessThanOrEqual(5)
    }
  })

  it('conserves the shift duration across all six participants', () => {
    const pt = shiftPlaytime(0, 5, lineup, splits)
    const total = [...pt.values()].reduce((a, b) => a + b, 0)
    // A substitution redistributes time, it does not create any: 5 on court for
    // 5 minutes is 25 player-minutes whatever happens mid-shift.
    expect(total).toBe(25)
  })

  it('handles a sub at the very start of a shift', () => {
    const pt = shiftPlaytime(0, 5, lineup, [{ minute: 0, playerOutId: 'a', playerInId: 'f' }])
    expect(pt.get('a')).toBe(0)
    expect(pt.get('f')).toBe(5)
  })

  it('handles a sub at the very end of a shift', () => {
    const pt = shiftPlaytime(0, 5, lineup, [{ minute: 5, playerOutId: 'a', playerInId: 'f' }])
    expect(pt.get('a')).toBe(5)
    expect(pt.get('f')).toBe(0)
  })
})

describe('shiftPlaytime with multiple substitutions in one shift', () => {
  it('divides the shift into thirds for two sub-outs', () => {
    // 'a' goes out at 1/3, 'c' at 2/3. Final lineup has b, d, e, f, g.
    // Each window is 5/3 long, but a player spans windows: 'c' is on court for
    // the first two, so 'c' plays 2/3 of the shift and 'g' plays 1/3 of it.
    const lineup = ['b', 'd', 'e', 'f', 'g']
    const splits = [
      { minute: 5 / 3, playerOutId: 'a', playerInId: 'f' },
      { minute: 10 / 3, playerOutId: 'c', playerInId: 'g' },
    ]
    const pt = shiftPlaytime(0, 5, lineup, splits)

    expect(pt.get('a')).toBeCloseTo(5 / 3, 5)     // [0, 1/3]
    expect(pt.get('f')).toBeCloseTo(10 / 3, 5)    // [1/3, end]
    expect(pt.get('c')).toBeCloseTo(10 / 3, 5)    // [0, 2/3]
    expect(pt.get('g')).toBeCloseTo(5 / 3, 5)     // [2/3, end]
    // b, d, e never left.
    expect(pt.get('b')).toBe(5)
    expect(pt.get('d')).toBe(5)
    expect(pt.get('e')).toBe(5)

    // Still 25 player-minutes overall.
    const total = [...pt.values()].reduce((x, y) => x + y, 0)
    expect(total).toBeCloseTo(25, 5)
  })

  it('handles a player subbed out and later back in', () => {
    const lineup = ['b', 'c', 'd', 'e', 'a']  // 'a' returns for 'f'
    const splits = [
      { minute: 1, playerOutId: 'a', playerInId: 'f' },
      { minute: 4, playerOutId: 'f', playerInId: 'a' },
    ]
    const pt = shiftPlaytime(0, 5, lineup, splits)

    expect(pt.get('a')).toBeCloseTo(1 + 1, 5)  // [0,1] then [4,5]
    expect(pt.get('f')).toBeCloseTo(3, 5)      // [1,4]
  })
})

describe('shiftPlaytime scope', () => {
  it('ignores splits belonging to other shifts in the same segment', () => {
    const pt = shiftPlaytime(5, 10, ['a', 'b', 'c', 'd', 'e'], [
      { minute: 2.5, playerOutId: 'a', playerInId: 'f' },  // belongs to 0–5
    ])
    expect(pt.get('a')).toBe(5)
    expect(pt.has('f')).toBe(false)
  })

  it('is position-independent, so split order in the input does not matter', () => {
    const splits = [
      { minute: 10 / 3, playerOutId: 'c', playerInId: 'g' },
      { minute: 5 / 3, playerOutId: 'a', playerInId: 'f' },
    ]
    const lineup = ['b', 'd', 'e', 'f', 'g']
    const forward = shiftPlaytime(0, 5, lineup, splits)
    const reversed = shiftPlaytime(0, 5, lineup, [...splits].reverse())
    expect(reversed).toEqual(forward)
  })
})

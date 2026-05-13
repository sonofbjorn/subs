interface PlayerTimeline {
  playerId: string
  totalPlaytime: number
  consecutivePlayed: number
  consecutiveRested: number
  lastShiftPlayed: boolean
}

interface ShiftResult {
  lineup: string[]
  shiftDuration: number
}

export interface LineupResult {
  segmentIndex: number
  shifts: ShiftResult[]
}

function weightedRandomPick(
  candidates: { playerId: string; weight: number }[],
  count: number,
): string[] {
  const pool = candidates.map(c => ({ ...c }))
  const result: string[] = []

  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((s, c) => s + c.weight, 0)
    let r = Math.random() * total
    let idx = 0
    for (let j = 0; j < pool.length; j++) {
      r -= pool[j].weight
      if (r <= 0) { idx = j; break }
    }
    result.push(pool[idx].playerId)
    pool.splice(idx, 1)
  }

  return result
}

export function generateLineups(
  activePlayerIds: string[],
  segmentCount: number,
  segmentDurationMinutes: number,
  intervalMinutes: number,
  existingPlaytime?: Map<string, number>,
): LineupResult[] {
  const timeline = new Map<string, PlayerTimeline>()

  for (const id of activePlayerIds) {
    timeline.set(id, {
      playerId: id,
      totalPlaytime: existingPlaytime?.get(id) ?? 0,
      consecutivePlayed: 0,
      consecutiveRested: 0,
      lastShiftPlayed: false,
    })
  }

  const results: LineupResult[] = []

  for (let seg = 0; seg < segmentCount; seg++) {
    const shiftsInSegment: ShiftResult[] = []
    let minute = 0

    while (minute < segmentDurationMinutes) {
      const shiftDuration = Math.min(intervalMinutes, segmentDurationMinutes - minute)

      const candidates = activePlayerIds.map(id => {
        const s = timeline.get(id)!
        const baseWeight = 1 / (1 + s.totalPlaytime)
        const restMultiplier = s.lastShiftPlayed
          ? 1.0
          : 1 + s.consecutiveRested * 0.3
        return { playerId: id, weight: baseWeight * restMultiplier }
      })

      const lineup = weightedRandomPick(candidates, Math.min(5, activePlayerIds.length))

      const lineupSet = new Set(lineup)
      for (const [id, s] of timeline) {
        if (lineupSet.has(id)) {
          s.totalPlaytime += shiftDuration
          s.consecutivePlayed++
          s.consecutiveRested = 0
          s.lastShiftPlayed = true
        } else {
          s.consecutiveRested++
          s.consecutivePlayed = 0
          s.lastShiftPlayed = false
        }
      }

      shiftsInSegment.push({ lineup, shiftDuration })
      minute += shiftDuration
    }

    results.push({ segmentIndex: seg, shifts: shiftsInSegment })
  }

  return results
}

export function calculatePlaytime(
  lineups: LineupResult[],
  existingPlaytime?: Map<string, number>,
): Map<string, number> {
  const pt = new Map(existingPlaytime)

  for (const seg of lineups) {
    for (const shift of seg.shifts) {
      for (const pid of shift.lineup) {
        pt.set(pid, (pt.get(pid) ?? 0) + shift.shiftDuration)
      }
    }
  }

  return pt
}

interface PlayerTimeline {
  playerId: string
  totalPlaytime: number
  consecutivePlayed: number
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

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pickLineup(
  timeline: Map<string, PlayerTimeline>,
  activePlayerIds: string[],
  shiftDuration: number,
  maxConsecutiveShifts: number,
): string[] {
  // Sort by total playtime ascending (players behind get priority)
  const sorted = [...activePlayerIds].sort((a, b) => {
    const ta = timeline.get(a)!.totalPlaytime
    const tb = timeline.get(b)!.totalPlaytime
    if (ta !== tb) return ta - tb
    return a < b ? -1 : 1
  })

  // Pick the 5 lowest-playtime players who haven't exceeded consecutive limit
  const lineup: string[] = []
  const skipped: string[] = []

  for (const pid of sorted) {
    if (lineup.length >= 5) break
    const tl = timeline.get(pid)!
    if (tl.lastShiftPlayed && tl.consecutivePlayed >= maxConsecutiveShifts) {
      skipped.push(pid)
      continue
    }
    lineup.push(pid)
  }

  // If not enough players due to consecutive limit, fill from skipped (lowest playtime first)
  for (const pid of skipped) {
    if (lineup.length >= 5) break
    lineup.push(pid)
  }

  // If still not enough (shouldn't happen with ≥5 players), fill from remaining
  if (lineup.length < 5) {
    for (const pid of sorted) {
      if (lineup.length >= 5) break
      if (!lineup.includes(pid)) lineup.push(pid)
    }
  }

  // Update timeline
  const lineupSet = new Set(lineup)
  for (const [id, tl] of timeline) {
    if (lineupSet.has(id)) {
      tl.totalPlaytime += shiftDuration
      tl.consecutivePlayed++
      tl.lastShiftPlayed = true
    } else {
      tl.consecutivePlayed = 0
      tl.lastShiftPlayed = false
    }
  }

  return lineup
}

export function generateLineups(
  activePlayerIds: string[],
  segmentCount: number,
  segmentDurationMinutes: number,
  intervalMinutes: number,
  existingPlaytime?: Map<string, number>,
  maxConsecutiveShifts: number = 2,
): LineupResult[] {
  const timeline = new Map<string, PlayerTimeline>()

  for (const id of activePlayerIds) {
    timeline.set(id, {
      playerId: id,
      totalPlaytime: existingPlaytime?.get(id) ?? 0,
      consecutivePlayed: 0,
      lastShiftPlayed: false,
    })
  }

  // Randomize initial order when all playtimes are equal (first shift of a fresh game)
  const initialOrder =
    activePlayerIds.length > 0 &&
    activePlayerIds.every(id => (existingPlaytime?.get(id) ?? 0) === (existingPlaytime?.get(activePlayerIds[0]) ?? 0))
      ? shuffle(activePlayerIds)
      : null
  let shiftCount = 0

  const results: LineupResult[] = []

  for (let seg = 0; seg < segmentCount; seg++) {
    const shiftsInSegment: ShiftResult[] = []
    let minute = 0

    while (minute < segmentDurationMinutes) {
      const shiftDuration = Math.min(intervalMinutes, segmentDurationMinutes - minute)

      const order = initialOrder && shiftCount === 0 ? initialOrder : activePlayerIds
      const lineup = pickLineup(timeline, order, shiftDuration, maxConsecutiveShifts)

      shiftsInSegment.push({ lineup, shiftDuration })
      minute += shiftDuration
      shiftCount++
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

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
  tiebreaker?: Map<string, number>,
): string[] {
  // Sort: rested players first (lastShiftPlayed=false), then by playtime ascending.
  // This ensures a player who sat out last shift always gets priority, so no one
  // sits two shifts in a row unless there are more than 10 players.
  // When playtimes are equal, use tiebreaker order if provided (for randomization),
  // otherwise fall back to alphabetical by ID.
  const sorted = [...activePlayerIds].sort((a, b) => {
    const ta = timeline.get(a)!
    const tb = timeline.get(b)!
    if (ta.lastShiftPlayed !== tb.lastShiftPlayed) {
      return ta.lastShiftPlayed ? 1 : -1
    }
    if (ta.totalPlaytime !== tb.totalPlaytime) {
      return ta.totalPlaytime - tb.totalPlaytime
    }
    if (tiebreaker) {
      return (tiebreaker.get(a) ?? 0) - (tiebreaker.get(b) ?? 0)
    }
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
  existingTimelineState?: Map<string, { consecutivePlayed: number; lastShiftPlayed: boolean }>,
): LineupResult[] {
  const timeline = new Map<string, PlayerTimeline>()

  for (const id of activePlayerIds) {
    const state = existingTimelineState?.get(id)
    timeline.set(id, {
      playerId: id,
      totalPlaytime: existingPlaytime?.get(id) ?? 0,
      consecutivePlayed: state?.consecutivePlayed ?? 0,
      lastShiftPlayed: state?.lastShiftPlayed ?? false,
    })
  }

  // When all playtimes are equal (fresh game or regeneration), shuffle the sort
  // tiebreaker so every call to generateLineups produces a different schedule.
  const allEqual =
    activePlayerIds.length > 0 &&
    activePlayerIds.every(id => (existingPlaytime?.get(id) ?? 0) === (existingPlaytime?.get(activePlayerIds[0]) ?? 0))
  const tiebreaker = allEqual
    ? new Map(shuffle(activePlayerIds).map((id, i) => [id, i]))
    : undefined

  const results: LineupResult[] = []

  for (let seg = 0; seg < segmentCount; seg++) {
    const shiftsInSegment: ShiftResult[] = []
    let minute = 0

    while (minute < segmentDurationMinutes) {
      const shiftDuration = Math.min(intervalMinutes, segmentDurationMinutes - minute)

      const lineup = pickLineup(timeline, activePlayerIds, shiftDuration, maxConsecutiveShifts, tiebreaker)

      shiftsInSegment.push({ lineup, shiftDuration })
      minute += shiftDuration
    }

    results.push({ segmentIndex: seg, shifts: shiftsInSegment })
  }

  return results
}

export function computeTimelineState(
  activePlayerIds: string[],
  completedLineups: string[][],
): Map<string, { consecutivePlayed: number; lastShiftPlayed: boolean }> {
  const state = new Map<string, { consecutivePlayed: number; lastShiftPlayed: boolean }>()
  for (const pid of activePlayerIds) {
    state.set(pid, { consecutivePlayed: 0, lastShiftPlayed: false })
  }
  for (const lineup of completedLineups) {
    const lineupSet = new Set(lineup)
    for (const [pid, s] of state) {
      if (lineupSet.has(pid)) {
        s.consecutivePlayed++
        s.lastShiftPlayed = true
      } else {
        s.consecutivePlayed = 0
        s.lastShiftPlayed = false
      }
    }
  }
  return state
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

import { db } from '../schema'
import type { GameStructure, Game, Shift } from '../../types'
import { generateLineups } from '../../algorithm/lineup'

interface CreateGameInput {
  teamId: string
  name: string
  activePlayerIds: string[]
  structure: GameStructure
  durationMinutes: number
  substitutionIntervalMinutes: number
  maxConsecutiveShifts?: number
}

export async function createGame(input: CreateGameInput): Promise<string> {
  const gameId = crypto.randomUUID()
  const now = new Date()

  const game: Game = {
    id: gameId,
    teamId: input.teamId,
    name: input.name,
    activePlayerIds: input.activePlayerIds,
    injuredPlayerIds: [],
    structure: input.structure,
    durationMinutes: input.durationMinutes,
    substitutionIntervalMinutes: input.substitutionIntervalMinutes,
    maxConsecutiveShifts: input.maxConsecutiveShifts ?? 2,
    status: 'DRAFT',
    createdAt: now,
  }

  await db.games.add(game)

  const segmentCount = input.structure === 'HALVES' ? 2 : 4
  const segments = []
  for (let i = 0; i < segmentCount; i++) {
    const label = input.structure === 'HALVES' ? `H${i + 1}` : `Q${i + 1}`
    segments.push({
      id: crypto.randomUUID(),
      gameId,
      number: i + 1,
      label,
      status: 'PENDING' as const,
    })
  }

  await db.segments.bulkAdd(segments)

  const lineups = generateLineups(
    input.activePlayerIds,
    segmentCount,
    input.durationMinutes,
    input.substitutionIntervalMinutes,
    undefined,
    input.maxConsecutiveShifts ?? 2,
  )

  const allShifts: Shift[] = []
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]
    const lineupSeg = lineups[s]
    let minute = 0
    for (const shiftResult of lineupSeg.shifts) {
      allShifts.push({
        id: crypto.randomUUID(),
        gameId,
        segmentId: segment.id,
        startMinute: minute,
        endMinute: minute + shiftResult.shiftDuration,
        lineupJson: JSON.stringify(shiftResult.lineup),
        status: 'PENDING' as const,
      })
      minute += shiftResult.shiftDuration
    }
  }

  if (allShifts.length) {
    await db.shifts.bulkAdd(allShifts)
  }

  return gameId
}

export async function recalculateLineups(gameId: string): Promise<void> {
  const game = await db.games.get(gameId)
  if (!game || game.status === 'COMPLETED') return

  const segments = await db.segments
    .where('gameId')
    .equals(gameId)
    .sortBy('number')

  const segmentCount = segments.length
  const activePlayerIds = game.activePlayerIds

  const lineups = generateLineups(
    activePlayerIds,
    segmentCount,
    game.durationMinutes,
    game.substitutionIntervalMinutes,
    undefined,
    game.maxConsecutiveShifts ?? 2,
  )

  const allShifts: Shift[] = []
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]
    const lineupSeg = lineups[s]
    let minute = 0
    for (const shiftResult of lineupSeg.shifts) {
      allShifts.push({
        id: crypto.randomUUID(),
        gameId,
        segmentId: segment.id,
        startMinute: minute,
        endMinute: minute + shiftResult.shiftDuration,
        lineupJson: JSON.stringify(shiftResult.lineup),
        status: 'PENDING' as const,
      })
      minute += shiftResult.shiftDuration
    }
  }

  const existingSegmentIds = segments.map(s => s.id)
  await db.shifts.where('segmentId').anyOf(existingSegmentIds).delete()
  await db.shifts.bulkAdd(allShifts)
}

export async function startGame(gameId: string): Promise<void> {
  await db.games.update(gameId, { status: 'ACTIVE' })
  const segments = await db.segments
    .where('gameId')
    .equals(gameId)
    .sortBy('number')
  if (segments.length > 0) {
    await db.segments.update(segments[0].id, { status: 'IN_PROGRESS' })
    const shifts = await db.shifts
      .where('segmentId')
      .equals(segments[0].id)
      .sortBy('startMinute')
    if (shifts.length > 0) {
      await db.shifts.update(shifts[0].id, { status: 'CURRENT' })
    }
  }
}

export async function advanceShift(gameId: string): Promise<void> {
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const currentShift = allShifts.find(s => s.status === 'CURRENT')
  if (!currentShift) return

  await db.shifts.update(currentShift.id, { status: 'COMPLETED' })

  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const currentSegment = segments.find(s => s.id === currentShift.segmentId)

  // Find next shift in same segment
  const segmentShifts = allShifts
    .filter(s => s.segmentId === currentShift.segmentId)
    .sort((a, b) => a.startMinute - b.startMinute)
  const shiftIdx = segmentShifts.findIndex(s => s.id === currentShift.id)

  if (shiftIdx < segmentShifts.length - 1) {
    // Next shift in same segment
    await db.shifts.update(segmentShifts[shiftIdx + 1].id, { status: 'CURRENT' })
  } else {
    // Segment complete
    if (currentSegment) {
      await db.segments.update(currentSegment.id, { status: 'COMPLETED' })
    }
    // Advance to next segment
    const segIdx = segments.findIndex(s => s.id === currentShift.segmentId)
    if (segIdx < segments.length - 1) {
      const nextSegment = segments[segIdx + 1]
      await db.segments.update(nextSegment.id, { status: 'IN_PROGRESS' })
      const nextShifts = allShifts
        .filter(s => s.segmentId === nextSegment.id)
        .sort((a, b) => a.startMinute - b.startMinute)
      if (nextShifts.length > 0) {
        await db.shifts.update(nextShifts[0].id, { status: 'CURRENT' })
      }
    } else {
      // Game complete
      await db.games.update(gameId, { status: 'COMPLETED' })
    }
  }
}

export async function uncompleteShift(gameId: string): Promise<void> {
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')

  // Find the last COMPLETED shift (the most recent one we can revert)
  const completed = allShifts.filter(s => s.status === 'COMPLETED').sort((a, b) => {
    const segA = segments.findIndex(seg => seg.id === a.segmentId)
    const segB = segments.findIndex(seg => seg.id === b.segmentId)
    if (segA !== segB) return segA - segB
    return a.startMinute - b.startMinute
  })

  const lastCompleted = completed[completed.length - 1]
  if (!lastCompleted) return

  // Set the CURRENT shift back to PENDING (if there is one)
  const current = allShifts.find(s => s.status === 'CURRENT')
  if (current) {
    await db.shifts.update(current.id, { status: 'PENDING' })
  }

  // Revert the last COMPLETED shift to CURRENT
  await db.shifts.update(lastCompleted.id, { status: 'CURRENT' })

  // Handle segment status cascading
  const lastCompletedSegment = segments.find(s => s.id === lastCompleted.segmentId)
  if (lastCompletedSegment && lastCompletedSegment.status === 'COMPLETED') {
    await db.segments.update(lastCompletedSegment.id, { status: 'IN_PROGRESS' })
  }

  // If the current shift was in a different segment, reset that segment
  if (current && current.segmentId !== lastCompleted.segmentId) {
    const oldSegment = segments.find(s => s.id === current.segmentId)
    if (oldSegment && oldSegment.status === 'IN_PROGRESS') {
      const oldSegShifts = allShifts.filter(s => s.segmentId === oldSegment.id)
      const anyCompleted = oldSegShifts.some(s => s.status === 'COMPLETED')
      if (!anyCompleted) {
        await db.segments.update(oldSegment.id, { status: 'PENDING' })
      }
    }
  }

  // Ensure game is ACTIVE
  const game = await db.games.get(gameId)
  if (game && game.status === 'COMPLETED') {
    await db.games.update(gameId, { status: 'ACTIVE' })
  }
}

export async function injurySub(
  gameId: string,
  shiftId: string,
  playerOutId: string,
  playerInId: string,
): Promise<void> {
  const game = await db.games.get(gameId)
  const shift = await db.shifts.get(shiftId)
  if (!game || !shift) return

  const splitMinute = Math.floor((shift.startMinute + shift.endMinute) / 2)

  // 1. Update game roster: move playerOut to injured, ensure playerIn is active
  const newActive = game.activePlayerIds.filter(id => id !== playerOutId)
  if (!newActive.includes(playerInId)) newActive.push(playerInId)
  const newInjured = [...(game.injuredPlayerIds ?? []).filter(id => id !== playerInId), playerOutId]
  await db.games.update(gameId, { activePlayerIds: newActive, injuredPlayerIds: newInjured })

  // 2. Update current shift lineup (swap out injured, keep other 4)
  const currentLineup: string[] = JSON.parse(shift.lineupJson)
  const updatedLineup = currentLineup.map(pid => pid === playerOutId ? playerInId : pid)
  await db.shifts.update(shiftId, { lineupJson: JSON.stringify(updatedLineup) })

  // 3. Create ShiftSplit record for playtime accounting
  await db.shiftSplits.add({
    id: crypto.randomUUID(),
    shiftId,
    minute: splitMinute,
    playerOutId,
    playerInId,
  })

  // 4. Recalculate future shifts with updated roster
  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const completedShiftIdSet = new Set(allShifts.filter(s => s.status === 'COMPLETED').map(s => s.id))

  // Calculate playtime from completed shifts + current shift split
  const existingPlaytime = new Map<string, number>()
  const shiftDuration = shift.endMinute - shift.startMinute

  for (const s of allShifts) {
    const lineup: string[] = JSON.parse(s.lineupJson)
    const dur = s.endMinute - s.startMinute

    if (s.id === shiftId) {
      for (const pid of currentLineup) {
        if (pid === playerOutId) {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + splitMinute)
        } else if (pid === playerInId) {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + (shiftDuration - splitMinute))
        } else {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + dur)
        }
      }
    } else if (completedShiftIdSet.has(s.id)) {
      for (const pid of lineup) {
        existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + dur)
      }
    }
  }

  for (const pid of newActive) {
    if (!existingPlaytime.has(pid)) existingPlaytime.set(pid, 0)
  }

  // Recalculate all future shifts in a single call for continuous consecutive tracking
  const currentSegIdx = segments.findIndex(s => s.id === shift.segmentId)
  const segmentShifts = allShifts
    .filter(s => s.segmentId === shift.segmentId)
    .sort((a, b) => a.startMinute - b.startMinute)
  const shiftIndexInSegment = segmentShifts.findIndex(s => s.id === shiftId)

  const allToReplace: { shiftId: string; duration: number }[] = []
  for (let si = currentSegIdx; si < segments.length; si++) {
    const segShifts = allShifts
      .filter(s => s.segmentId === segments[si].id)
      .sort((a, b) => a.startMinute - b.startMinute)
    const isCurrentSegment = si === currentSegIdx
    const toReplace = isCurrentSegment
      ? segShifts.slice(shiftIndexInSegment + 1)
      : segShifts
    for (const s of toReplace) {
      allToReplace.push({ shiftId: s.id, duration: s.endMinute - s.startMinute })
    }
  }

  if (allToReplace.length === 0) return

  const totalDuration = allToReplace.reduce((sum, s) => sum + s.duration, 0)
  const lineupResults = generateLineups(
    newActive,
    1,
    totalDuration,
    game.substitutionIntervalMinutes,
    existingPlaytime,
    game.maxConsecutiveShifts ?? 2,
  )

  for (const shiftRes of lineupResults[0]?.shifts ?? []) {
    for (const pid of shiftRes.lineup) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + shiftRes.shiftDuration)
    }
  }

  for (let i = 0; i < allToReplace.length && i < (lineupResults[0]?.shifts.length ?? 0); i++) {
    await db.shifts.update(allToReplace[i].shiftId, {
      lineupJson: JSON.stringify(lineupResults[0].shifts[i].lineup),
    })
  }
}

export async function updateActiveRoster(
  gameId: string,
  newActivePlayerIds: string[],
): Promise<void> {
  const game = await db.games.get(gameId)
  if (!game) return

  await db.games.update(gameId, { activePlayerIds: newActivePlayerIds, injuredPlayerIds: [] })

  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const allSplits = await db.shiftSplits.toArray()

  const completedShiftIds = new Set(allShifts.filter(s => s.status === 'COMPLETED').map(s => s.id))
  const currentShift = allShifts.find(s => s.status === 'CURRENT')
  const currentSegIdx = currentShift
    ? segments.findIndex(s => s.id === currentShift.segmentId)
    : -1

  if (currentSegIdx < 0) return

  // Calculate existing playtime from completed shifts
  const existingPlaytime = new Map<string, number>()
  for (const s of allShifts) {
    if (!completedShiftIds.has(s.id)) continue
    const lineup: string[] = JSON.parse(s.lineupJson)
    const dur = s.endMinute - s.startMinute
    for (const pid of lineup) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + dur)
    }
  }

  // Handle splits in completed shifts
  for (const split of allSplits) {
    if (!completedShiftIds.has(split.shiftId)) continue
    const shift = allShifts.find(s => s.id === split.shiftId)
    if (!shift) continue
    const lineup: string[] = JSON.parse(shift.lineupJson)
    const dur = shift.endMinute - shift.startMinute
    for (const pid of lineup) {
      const existing = existingPlaytime.get(pid) ?? 0
      if (pid === split.playerOutId) {
        existingPlaytime.set(pid, existing - dur + split.minute)
      } else if (pid === split.playerInId) {
        existingPlaytime.set(pid, existing + (dur - split.minute))
      }
    }
  }

  for (const pid of newActivePlayerIds) {
    if (!existingPlaytime.has(pid)) existingPlaytime.set(pid, 0)
  }

  // Flatten all remaining shifts for a single generation call (continuous consecutive tracking)
  const currentSegShifts = currentShift
    ? allShifts
        .filter(s => s.segmentId === currentShift.segmentId)
        .sort((a, b) => a.startMinute - b.startMinute)
    : []
  const currentShiftIndex = currentSegShifts.findIndex(s => s.id === currentShift?.id)

  const allToReplace: { shiftId: string; duration: number }[] = []
  for (let si = currentSegIdx; si < segments.length; si++) {
    const segShifts = allShifts
      .filter(s => s.segmentId === segments[si].id)
      .sort((a, b) => a.startMinute - b.startMinute)
    if (segShifts.length === 0) continue
    const isFirst = si === currentSegIdx
    const toReplace = isFirst ? segShifts.slice(currentShiftIndex + 1) : segShifts
    for (const s of toReplace) {
      allToReplace.push({ shiftId: s.id, duration: s.endMinute - s.startMinute })
    }
  }

  if (allToReplace.length === 0) return

  const totalDuration = allToReplace.reduce((sum, s) => sum + s.duration, 0)

  const lineupResults = generateLineups(
    newActivePlayerIds,
    1,
    totalDuration,
    game.substitutionIntervalMinutes,
    existingPlaytime,
    game.maxConsecutiveShifts ?? 2,
  )

  for (const shiftRes of lineupResults[0]?.shifts ?? []) {
    for (const pid of shiftRes.lineup) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + shiftRes.shiftDuration)
    }
  }

  for (let i = 0; i < allToReplace.length && i < (lineupResults[0]?.shifts.length ?? 0); i++) {
    await db.shifts.update(allToReplace[i].shiftId, {
      lineupJson: JSON.stringify(lineupResults[0].shifts[i].lineup),
    })
  }
}

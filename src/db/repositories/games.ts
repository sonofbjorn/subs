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
}

export async function createGame(input: CreateGameInput): Promise<string> {
  const gameId = crypto.randomUUID()
  const now = new Date()

  const game: Game = {
    id: gameId,
    teamId: input.teamId,
    name: input.name,
    activePlayerIds: input.activePlayerIds,
    structure: input.structure,
    durationMinutes: input.durationMinutes,
    substitutionIntervalMinutes: input.substitutionIntervalMinutes,
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
  }
}

export async function completeSegment(gameId: string, segmentId: string): Promise<void> {
  await db.segments.update(segmentId, { status: 'COMPLETED' })

  const segments = await db.segments
    .where('gameId')
    .equals(gameId)
    .sortBy('number')

  const currentIdx = segments.findIndex(s => s.id === segmentId)
  const nextSegment = currentIdx >= 0 && currentIdx < segments.length - 1 ? segments[currentIdx + 1] : null

  if (nextSegment) {
    await db.segments.update(nextSegment.id, { status: 'IN_PROGRESS' })
  } else {
    await db.games.update(gameId, { status: 'COMPLETED' })
  }
}

export async function uncompleteSegment(gameId: string, segmentId: string): Promise<void> {
  await db.segments.update(segmentId, { status: 'IN_PROGRESS' })

  const segments = await db.segments
    .where('gameId')
    .equals(gameId)
    .sortBy('number')

  const currentIdx = segments.findIndex(s => s.id === segmentId)
  if (currentIdx < segments.length - 1) {
    const nextSegment = segments[currentIdx + 1]
    await db.segments.update(nextSegment.id, { status: 'PENDING' })
  }

  await db.games.update(gameId, { status: 'ACTIVE' })
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

  await db.shiftSplits.add({
    id: crypto.randomUUID(),
    shiftId,
    minute: splitMinute,
    playerOutId,
    playerInId,
  })

  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const completedSegmentIds = segments.filter(s => s.status === 'COMPLETED').map(s => s.id)

  // Calculate playtime from completed segments + current shift split
  const existingPlaytime = new Map<string, number>()
  const shiftDuration = shift.endMinute - shift.startMinute

  for (const s of allShifts) {
    const lineup: string[] = JSON.parse(s.lineupJson)
    const dur = s.endMinute - s.startMinute

    if (s.id === shiftId) {
      for (const pid of lineup) {
        if (pid === playerOutId) {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + splitMinute)
        } else if (pid === playerInId) {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + (shiftDuration - splitMinute))
        } else {
          existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + dur)
        }
      }
    } else if (completedSegmentIds.includes(s.segmentId)) {
      for (const pid of lineup) {
        existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + dur)
      }
    }
  }

  for (const pid of game.activePlayerIds) {
    if (!existingPlaytime.has(pid)) existingPlaytime.set(pid, 0)
  }

  // Find the current segment index and recalculate from the next shift onward
  const currentSegIdx = segments.findIndex(s => s.id === shift.segmentId)
  const segmentShifts = allShifts
    .filter(s => s.segmentId === shift.segmentId)
    .sort((a, b) => a.startMinute - b.startMinute)
  const shiftIndexInSegment = segmentShifts.findIndex(s => s.id === shiftId)

  for (let si = currentSegIdx; si < segments.length; si++) {
    const segment = segments[si]
    const isCurrentSegment = si === currentSegIdx
    const segShifts = allShifts
      .filter(s => s.segmentId === segment.id)
      .sort((a, b) => a.startMinute - b.startMinute)

    const interval = game.substitutionIntervalMinutes
    const segShiftsToReplace = isCurrentSegment
      ? segShifts.slice(shiftIndexInSegment + 1)
      : segShifts

    if (segShiftsToReplace.length > 0) {
      const lineupResults = generateLineups(
        game.activePlayerIds,
        1,
        segShiftsToReplace.reduce((sum, s) => sum + (s.endMinute - s.startMinute), 0),
        interval,
        existingPlaytime,
      )

      // Update playtime with newly generated shifts
      for (const lineupSeg of lineupResults) {
        for (const shiftRes of lineupSeg.shifts) {
          for (const pid of shiftRes.lineup) {
            existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + shiftRes.shiftDuration)
          }
        }
      }

      let minute = segShiftsToReplace[0].startMinute
      for (let i = 0; i < segShiftsToReplace.length && i < lineupResults[0]?.shifts.length; i++) {
        const shiftRes = lineupResults[0].shifts[i]
        const targetShift = segShiftsToReplace[i]
        await db.shifts.update(targetShift.id, {
          lineupJson: JSON.stringify(shiftRes.lineup),
        })
        minute += shiftRes.shiftDuration
      }
    }
  }
}

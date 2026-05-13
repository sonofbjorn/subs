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

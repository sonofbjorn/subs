import { db } from '../schema'
import type { GameStructure, Game } from '../../types'

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

  return gameId
}

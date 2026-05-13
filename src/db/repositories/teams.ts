import { db } from '../schema'

export async function createTeam(name: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.teams.add({ id, name, createdAt: new Date() })
  return id
}

export async function renameTeam(id: string, name: string): Promise<void> {
  await db.teams.update(id, { name })
}

export async function deleteTeam(id: string): Promise<void> {
  const players = await db.players.where('teamId').equals(id).toArray()
  const playerIds = players.map(p => p.id)

  const games = await db.games.where('teamId').equals(id).toArray()
  const gameIds = games.map(g => g.id)

  const segments = await db.segments.where('gameId').anyOf(gameIds).toArray()
  const segmentIds = segments.map(s => s.id)

  const shifts = await db.shifts.where('segmentId').anyOf(segmentIds).toArray()
  const shiftIds = shifts.map(s => s.id)

  if (shiftIds.length) await db.shiftSplits.where('shiftId').anyOf(shiftIds).delete()
  if (segmentIds.length) await db.shifts.where('segmentId').anyOf(segmentIds).delete()
  if (gameIds.length) await db.segments.where('gameId').anyOf(gameIds).delete()
  if (gameIds.length) await db.plannedPlaytimes.where('gameId').anyOf(gameIds).delete()
  if (gameIds.length) await db.games.where('id').anyOf(gameIds).delete()
  if (playerIds.length) await db.players.where('id').anyOf(playerIds).delete()

  await db.teams.delete(id)
}

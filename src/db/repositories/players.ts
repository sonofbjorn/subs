import { db } from '../schema'
import type { Player, Position } from '../../types'

export async function addPlayer(
  teamId: string,
  name: string,
  number?: number,
  position?: Position,
): Promise<string> {
  const id = crypto.randomUUID()
  await db.players.add({ id, teamId, name, number, isArchived: false, position })
  return id
}

export async function updatePlayer(
  id: string,
  data: Partial<Pick<Player, 'name' | 'number' | 'position'>>,
): Promise<void> {
  await db.players.update(id, data)
}

/** Reads live position values for the given players, keyed by player id. */
export async function getPositionMap(playerIds: string[]): Promise<Map<string, Position | undefined>> {
  const positions = new Map<string, Position | undefined>()
  if (playerIds.length === 0) return positions
  const rows = await db.players.where('id').anyOf(playerIds).toArray()
  for (const row of rows) positions.set(row.id, row.position)
  return positions
}

export async function archivePlayer(id: string): Promise<void> {
  await db.players.update(id, { isArchived: true })
}

export async function unarchivePlayer(id: string): Promise<void> {
  await db.players.update(id, { isArchived: false })
}

export async function isDuplicateName(teamId: string, name: string, excludeId?: string): Promise<boolean> {
  const players = await db.players
    .where('teamId')
    .equals(teamId)
    .toArray()
  return players.some(p => p.name.toLowerCase() === name.toLowerCase() && p.id !== excludeId)
}

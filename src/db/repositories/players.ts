import { db } from '../schema'
import type { Player } from '../../types'

export async function addPlayer(teamId: string, name: string, number?: number): Promise<string> {
  const id = crypto.randomUUID()
  await db.players.add({ id, teamId, name, number, isArchived: false })
  return id
}

export async function updatePlayer(id: string, data: Partial<Pick<Player, 'name' | 'number'>>): Promise<void> {
  await db.players.update(id, data)
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

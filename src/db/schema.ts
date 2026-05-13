import Dexie, { type EntityTable } from 'dexie'
import type { Team, Player, Game, Segment, Shift, ShiftSplit, PlannedPlaytime } from '../types'

export class SubsDB extends Dexie {
  teams!: EntityTable<Team, 'id'>
  players!: EntityTable<Player, 'id'>
  games!: EntityTable<Game, 'id'>
  segments!: EntityTable<Segment, 'id'>
  shifts!: EntityTable<Shift, 'id'>
  shiftSplits!: EntityTable<ShiftSplit, 'id'>
  plannedPlaytimes!: EntityTable<PlannedPlaytime, 'id'>

  constructor() {
    super('subs')
    this.version(1).stores({
      teams: '&id, name, createdAt',
      players: '&id, teamId, name, number, isArchived',
      games: '&id, teamId, name, status, createdAt',
      segments: '&id, gameId, number, status',
      shifts: '&id, segmentId, startMinute, endMinute',
      shiftSplits: '&id, shiftId, minute, playerOutId, playerInId',
      plannedPlaytimes: '&id, gameId, playerId, plannedMinutes',
    })
  }
}

export const db = new SubsDB()

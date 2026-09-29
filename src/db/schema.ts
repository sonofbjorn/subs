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
      shifts: '&id, gameId, segmentId, startMinute, endMinute',
      shiftSplits: '&id, shiftId, minute, playerOutId, playerInId',
      plannedPlaytimes: '&id, gameId, playerId, plannedMinutes',
    })
    this.version(2).stores({
      teams: '&id, name, createdAt',
      players: '&id, teamId, name, number, isArchived',
      games: '&id, teamId, name, status, createdAt',
      segments: '&id, gameId, number, status',
      shifts: '&id, gameId, segmentId, startMinute, endMinute, status',
      shiftSplits: '&id, shiftId, minute, playerOutId, playerInId',
      plannedPlaytimes: '&id, gameId, playerId, plannedMinutes',
    })
    // `Player.position`, `Game.lineupTemplate`/`lineupPriority` and
    // `Team.defaultLineupTemplate`/`defaultLineupPriority` are deliberately NOT indexed,
    // so they need no version block and no migration. Dexie returns the whole stored
    // object on read, so existing rows simply surface these as `undefined` — which
    // every consumer must treat as a real case (absent template => position-blind
    // algorithm; absent priority => BALANCED). A bump is only needed if one of these
    // ever becomes indexed, e.g. a "find me the centers" query.
  }
}

export const db = new SubsDB()

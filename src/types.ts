export interface Team {
  id: string
  name: string
  createdAt: Date
}

export interface Player {
  id: string
  teamId: string
  name: string
  number?: number
  isArchived: boolean
}

export type GameStructure = 'HALVES' | 'QUARTERS'
export type GameStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED'

export interface Game {
  id: string
  teamId: string
  name: string
  activePlayerIds: string[]
  structure: GameStructure
  durationMinutes: number
  substitutionIntervalMinutes: number
  status: GameStatus
  createdAt: Date
}

export type SegmentStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'

export interface Segment {
  id: string
  gameId: string
  number: number
  label: string
  status: SegmentStatus
}

export type ShiftStatus = 'PENDING' | 'CURRENT' | 'COMPLETED'

export interface Shift {
  id: string
  gameId: string
  segmentId: string
  startMinute: number
  endMinute: number
  lineupJson: string
  status: ShiftStatus
}

export interface ShiftSplit {
  id: string
  shiftId: string
  minute: number
  playerOutId: string
  playerInId: string
}

export interface PlannedPlaytime {
  id: string
  gameId: string
  playerId: string
  plannedMinutes: number
}

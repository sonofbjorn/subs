/** A single court position. A player has at most one, or none (see `Player.position`). */
export type Position = 'G' | 'F' | 'C'

/**
 * How strongly a game's lineup template is enforced.
 * - BALANCED: honor the template unless doing so costs more than one shift of fairness
 * - EQUAL_TIME: ignore the template entirely; play purely clock-based
 * - TEMPLATE: hard constraint; fairness and the consecutive limit yield to it
 */
export type LineupPriority = 'BALANCED' | 'EQUAL_TIME' | 'TEMPLATE'

/** A lineup template is always exactly 5 entries — one per player on court. */
export type LineupTemplate = Position[]

export interface Team {
  id: string
  name: string
  createdAt: Date
  /** Pre-fills Game Setup only; a game's own values win once chosen. */
  defaultLineupTemplate?: LineupTemplate
  defaultLineupPriority?: LineupPriority
}

export interface Player {
  id: string
  teamId: string
  name: string
  number?: number
  isArchived: boolean
  /**
   * Absent means **flex** — eligible for any template slot, not "unplayable".
   * Legacy rows have no `position` and must be treated as flex.
   */
  position?: Position
}

export type GameStructure = 'HALVES' | 'QUARTERS'
export type GameStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED'

export interface Game {
  id: string
  teamId: string
  name: string
  activePlayerIds: string[]
  injuredPlayerIds: string[]
  structure: GameStructure
  durationMinutes: number
  substitutionIntervalMinutes: number
  maxConsecutiveShifts: number
  status: GameStatus
  createdAt: Date
  /**
   * When the coach hit "Start Game", set once by `startGame`.
   *
   * Non-indexed, so no schema version block and no migration: existing rows read back as
   * `undefined`. The game history list sorts on `completedAt ?? startedAt ?? createdAt`
   * because `createdAt` is when the game was *set up*, which for a game planned days
   * ahead is not when it was played.
   */
  startedAt?: Date
  /**
   * When the final shift was completed. Set by `advanceShift`, and **cleared by
   * `uncompleteShift`** — which flips the game back to `ACTIVE` and writes nothing else,
   * so a field added only to the completion branch would survive the revert and leave an
   * in-progress game sorted by a stale finish time.
   */
  completedAt?: Date
  /**
   * Snapshotted at game creation. Absent means "no template" and the
   * position-blind algorithm runs regardless of priority. Legacy rows have no
   * `lineupTemplate`.
   */
  lineupTemplate?: LineupTemplate
  /** Absent defaults to BALANCED, but a template is what actually engages the solver. */
  lineupPriority?: LineupPriority
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

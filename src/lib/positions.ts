import type { LineupTemplate, Position } from '../types'

export const ALL_POSITIONS: Position[] = ['G', 'F', 'C']

export const POSITION_LABELS: Record<Position, string> = {
  G: 'Guard',
  F: 'Forward',
  C: 'Center',
}

export const POSITION_TITLES: Record<Position, string> = POSITION_LABELS

/** One-tap starting points. Arbitrary templates stay reachable via the slot chips. */
export const PRESET_TEMPLATES: Record<string, LineupTemplate> = {
  Balanced: ['G', 'G', 'F', 'F', 'C'],
  Passing: ['G', 'G', 'G', 'F', 'F'],
  Big: ['G', 'F', 'F', 'C', 'C'],
}

export const PRIORITY_LABELS: Record<
  'BALANCED' | 'EQUAL_TIME' | 'TEMPLATE',
  { label: string; help: string }
> = {
  BALANCED: {
    label: 'Balanced',
    help: 'Follow the template unless doing so costs more than one shift of playing time.',
  },
  EQUAL_TIME: {
    label: 'Equal time',
    help: 'Ignore the template. Everyone shares playing time as evenly as possible.',
  },
  TEMPLATE: {
    label: 'Template first',
    help: 'The template is a hard rule. Playing time and rest yield to it.',
  },
}

/** `undefined` (no position, or an empty slot) advances to G first. */
export function nextPosition(current?: Position): Position {
  return ALL_POSITIONS[(ALL_POSITIONS.indexOf(current as Position) + 1) % ALL_POSITIONS.length]
}

import { db } from '../schema'
import type { GameStructure, Game, Shift, LineupTemplate, LineupPriority } from '../../types'
import { generateLineups, computeTimelineState } from '../../algorithm/lineup'
import { shiftPlaytime, splitMinuteFor } from '../../algorithm/playtime'
import { getPositionMap } from './players'
import type { PositionConfig } from '../../algorithm/positions'

interface CreateGameInput {
  teamId: string
  name: string
  activePlayerIds: string[]
  structure: GameStructure
  durationMinutes: number
  substitutionIntervalMinutes: number
  maxConsecutiveShifts?: number
  /** Snapshotted onto the game. Absent means "no template" — position-blind forever. */
  lineupTemplate?: LineupTemplate
  lineupPriority?: LineupPriority
}

/**
 * Builds the solver config for one generation pass, or `undefined` when the game has
 * no template.
 *
 * Returning `undefined` (rather than a config with `template: undefined`) is what
 * guarantees the no-template case is byte-identical to the pre-feature algorithm:
 * `generateLineups` then takes the position-blind branch with no position lookup at
 * all, so an unpositioned legacy roster cannot be affected by this feature.
 *
 * Positions are read live from the `Player` rows on every mid-game regeneration, so
 * fixing a mislabeled player immediately affects the next plan, while the template
 * itself stays frozen on the game as the coach set it at creation.
 */
async function buildPositionConfig(
  game: Pick<Game, 'lineupTemplate' | 'lineupPriority'>,
  playerIds: string[],
  phase: 'create' | 'midgame',
): Promise<PositionConfig | undefined> {
  if (!game.lineupTemplate) return undefined
  return {
    positions: await getPositionMap(playerIds),
    template: game.lineupTemplate,
    priority: game.lineupPriority ?? 'BALANCED',
    phase,
  }
}

export async function createGame(input: CreateGameInput): Promise<string> {
  const gameId = crypto.randomUUID()
  const now = new Date()

  const game: Game = {
    id: gameId,
    teamId: input.teamId,
    name: input.name,
    activePlayerIds: input.activePlayerIds,
    injuredPlayerIds: [],
    structure: input.structure,
    durationMinutes: input.durationMinutes,
    substitutionIntervalMinutes: input.substitutionIntervalMinutes,
    maxConsecutiveShifts: input.maxConsecutiveShifts ?? 2,
    status: 'DRAFT',
    createdAt: now,
    lineupTemplate: input.lineupTemplate,
    lineupPriority: input.lineupPriority,
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
    undefined,
    input.maxConsecutiveShifts ?? 2,
    undefined,
    // `phase: 'create'` is the only place rule (c) applies: an unsatisfiable template
    // falls back to the position-blind plan instead of paying a mismatch penalty on
    // every shift for a template that can never be honored. Warned about in the UI, but
    // never allowed to block game creation.
    await buildPositionConfig(game, input.activePlayerIds, 'create'),
  )

  const allShifts: Shift[] = []
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]
    const lineupSeg = lineups[s]
    let minute = 0
    for (const shiftResult of lineupSeg.shifts) {
      allShifts.push({
        id: crypto.randomUUID(),
        gameId,
        segmentId: segment.id,
        startMinute: minute,
        endMinute: minute + shiftResult.shiftDuration,
        lineupJson: JSON.stringify(shiftResult.lineup),
        status: 'PENDING' as const,
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
    undefined,
    game.maxConsecutiveShifts ?? 2,
    undefined,
    await buildPositionConfig(game, activePlayerIds, 'midgame'),
  )

  const allShifts: Shift[] = []
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]
    const lineupSeg = lineups[s]
    let minute = 0
    for (const shiftResult of lineupSeg.shifts) {
      allShifts.push({
        id: crypto.randomUUID(),
        gameId,
        segmentId: segment.id,
        startMinute: minute,
        endMinute: minute + shiftResult.shiftDuration,
        lineupJson: JSON.stringify(shiftResult.lineup),
        status: 'PENDING' as const,
      })
      minute += shiftResult.shiftDuration
    }
  }

  const existingSegmentIds = segments.map(s => s.id)
  await db.shifts.where('segmentId').anyOf(existingSegmentIds).delete()
  await db.shifts.bulkAdd(allShifts)
}

export async function startGame(gameId: string): Promise<void> {
  // `startedAt` is written only on the DRAFT -> ACTIVE transition, so resuming a game
  // that is already in progress keeps the original tip-off time.
  const existing = await db.games.get(gameId)
  await db.games.update(gameId, existing?.startedAt
    ? { status: 'ACTIVE' }
    : { status: 'ACTIVE', startedAt: new Date() })
  const segments = await db.segments
    .where('gameId')
    .equals(gameId)
    .sortBy('number')
  if (segments.length > 0) {
    await db.segments.update(segments[0].id, { status: 'IN_PROGRESS' })
    const shifts = await db.shifts
      .where('segmentId')
      .equals(segments[0].id)
      .sortBy('startMinute')
    if (shifts.length > 0) {
      await db.shifts.update(shifts[0].id, { status: 'CURRENT' })
    }
  }
}

export async function advanceShift(gameId: string): Promise<void> {
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const currentShift = allShifts.find(s => s.status === 'CURRENT')
  if (!currentShift) return

  await db.shifts.update(currentShift.id, { status: 'COMPLETED' })

  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const currentSegment = segments.find(s => s.id === currentShift.segmentId)

  // Find next shift in same segment
  const segmentShifts = allShifts
    .filter(s => s.segmentId === currentShift.segmentId)
    .sort((a, b) => a.startMinute - b.startMinute)
  const shiftIdx = segmentShifts.findIndex(s => s.id === currentShift.id)

  if (shiftIdx < segmentShifts.length - 1) {
    // Next shift in same segment
    await db.shifts.update(segmentShifts[shiftIdx + 1].id, { status: 'CURRENT' })
  } else {
    // Segment complete
    if (currentSegment) {
      await db.segments.update(currentSegment.id, { status: 'COMPLETED' })
    }
    // Advance to next segment
    const segIdx = segments.findIndex(s => s.id === currentShift.segmentId)
    if (segIdx < segments.length - 1) {
      const nextSegment = segments[segIdx + 1]
      await db.segments.update(nextSegment.id, { status: 'IN_PROGRESS' })
      const nextShifts = allShifts
        .filter(s => s.segmentId === nextSegment.id)
        .sort((a, b) => a.startMinute - b.startMinute)
      if (nextShifts.length > 0) {
        await db.shifts.update(nextShifts[0].id, { status: 'CURRENT' })
      }
    } else {
      // Game complete. This is the only branch that sets `completedAt` — a segment
      // boundary or an intra-segment advance must not stamp a finish time.
      await db.games.update(gameId, { status: 'COMPLETED', completedAt: new Date() })
    }
  }
}

export async function uncompleteShift(gameId: string): Promise<void> {
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')

  // Find the last COMPLETED shift (the most recent one we can revert)
  const completed = allShifts.filter(s => s.status === 'COMPLETED').sort((a, b) => {
    const segA = segments.findIndex(seg => seg.id === a.segmentId)
    const segB = segments.findIndex(seg => seg.id === b.segmentId)
    if (segA !== segB) return segA - segB
    return a.startMinute - b.startMinute
  })

  const lastCompleted = completed[completed.length - 1]
  if (!lastCompleted) return

  // Set the CURRENT shift back to PENDING (if there is one)
  const current = allShifts.find(s => s.status === 'CURRENT')
  if (current) {
    await db.shifts.update(current.id, { status: 'PENDING' })
  }

  // Revert the last COMPLETED shift to CURRENT
  await db.shifts.update(lastCompleted.id, { status: 'CURRENT' })

  // Handle segment status cascading
  const lastCompletedSegment = segments.find(s => s.id === lastCompleted.segmentId)
  if (lastCompletedSegment && lastCompletedSegment.status === 'COMPLETED') {
    await db.segments.update(lastCompletedSegment.id, { status: 'IN_PROGRESS' })
  }

  // If the current shift was in a different segment, reset that segment
  if (current && current.segmentId !== lastCompleted.segmentId) {
    const oldSegment = segments.find(s => s.id === current.segmentId)
    if (oldSegment && oldSegment.status === 'IN_PROGRESS') {
      const oldSegShifts = allShifts.filter(s => s.segmentId === oldSegment.id)
      const anyCompleted = oldSegShifts.some(s => s.status === 'COMPLETED')
      if (!anyCompleted) {
        await db.segments.update(oldSegment.id, { status: 'PENDING' })
      }
    }
  }

  // Ensure game is ACTIVE.
  //
  // `completedAt` is cleared in the same update, and it has to be: this function writes
  // nothing else to the game row, so a stamp added only to `advanceShift` would outlive
  // the revert and leave an in-progress game sorted by a finish time it no longer has.
  // Clearing it restores the `startedAt` fallback, which is the right answer for a game
  // in progress.
  const game = await db.games.get(gameId)
  if (game && game.status === 'COMPLETED') {
    await db.games.update(gameId, { status: 'ACTIVE', completedAt: undefined })
  }
}

export async function injurySub(
  gameId: string,
  shiftId: string,
  playerOutId: string,
  playerInId: string,
): Promise<void> {
  const game = await db.games.get(gameId)
  const shift = await db.shifts.get(shiftId)
  if (!game || !shift) return

  const splitMinute = splitMinuteFor(shift.startMinute, shift.endMinute)

  // 1. Update game roster: move playerOut to injured, ensure playerIn is active
  const newActive = game.activePlayerIds.filter(id => id !== playerOutId)
  if (!newActive.includes(playerInId)) newActive.push(playerInId)
  const newInjured = [...(game.injuredPlayerIds ?? []).filter(id => id !== playerInId), playerOutId]
  await db.games.update(gameId, { activePlayerIds: newActive, injuredPlayerIds: newInjured })

  // 2. Update current shift lineup (swap out injured, keep other 4)
  const currentLineup: string[] = JSON.parse(shift.lineupJson)
  const updatedLineup = currentLineup.map(pid => pid === playerOutId ? playerInId : pid)
  await db.shifts.update(shiftId, { lineupJson: JSON.stringify(updatedLineup) })

  // 3. Create ShiftSplit record for playtime accounting
  await db.shiftSplits.add({
    id: crypto.randomUUID(),
    shiftId,
    minute: splitMinute,
    playerOutId,
    playerInId,
  })

  // 4. Recalculate future shifts with updated roster
  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const completedShiftIdSet = new Set(allShifts.filter(s => s.status === 'COMPLETED').map(s => s.id))

  // Calculate playtime from completed shifts + the current shift (which now
  // carries the new split). Splits are resolved by `shiftPlaytime`, which reads
  // the position off each ShiftSplit and splits the shift's duration there.
  const allSplits = await db.shiftSplits.toArray()
  const existingPlaytime = new Map<string, number>()

  for (const s of allShifts) {
    const isCurrentShift = s.id === shiftId
    if (!isCurrentShift && !completedShiftIdSet.has(s.id)) continue

    // The current shift's stored lineup is already post-swap (updated in step 2);
    // `updatedLineup` is used directly rather than re-reading a stale `shift`.
    const lineup: string[] = isCurrentShift ? updatedLineup : JSON.parse(s.lineupJson)
    const splits = allSplits.filter(sp => sp.shiftId === s.id)

    for (const [pid, mins] of shiftPlaytime(s.startMinute, s.endMinute, lineup, splits)) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + mins)
    }
  }

  for (const pid of newActive) {
    if (!existingPlaytime.has(pid)) existingPlaytime.set(pid, 0)
  }

  // Recalculate all future shifts in a single call for continuous consecutive tracking
  const currentSegIdx = segments.findIndex(s => s.id === shift.segmentId)
  const segmentShifts = allShifts
    .filter(s => s.segmentId === shift.segmentId)
    .sort((a, b) => a.startMinute - b.startMinute)
  const shiftIndexInSegment = segmentShifts.findIndex(s => s.id === shiftId)

  const allToReplace: { shiftId: string; duration: number }[] = []
  for (let si = currentSegIdx; si < segments.length; si++) {
    const segShifts = allShifts
      .filter(s => s.segmentId === segments[si].id)
      .sort((a, b) => a.startMinute - b.startMinute)
    const isCurrentSegment = si === currentSegIdx
    const toReplace = isCurrentSegment
      ? segShifts.slice(shiftIndexInSegment + 1)
      : segShifts
    for (const s of toReplace) {
      allToReplace.push({ shiftId: s.id, duration: s.endMinute - s.startMinute })
    }
  }

  if (allToReplace.length === 0) return

  const totalDuration = allToReplace.reduce((sum, s) => sum + s.duration, 0)

  // Build timeline state from completed + current shift so consecutive tracking is preserved
  const shiftsChronological = [...allShifts].sort((a, b) => {
    const siA = segments.findIndex(s => s.id === a.segmentId)
    const siB = segments.findIndex(s => s.id === b.segmentId)
    if (siA !== siB) return siA - siB
    return a.startMinute - b.startMinute
  })
  const stateLineups: string[][] = []
  for (const s of shiftsChronological) {
    if (s.id === shiftId) {
      // Post-swap: the replacement is on court right now, so it must not be treated
      // as rested. (The player who went out is no longer in `newActive`, so their
      // absence here does not affect the timeline.)
      stateLineups.push(updatedLineup)
    } else if (completedShiftIdSet.has(s.id)) {
      stateLineups.push(JSON.parse(s.lineupJson))
    }
  }
  const existingState = computeTimelineState(newActive, stateLineups)

  const lineupResults = generateLineups(
    newActive,
    1,
    totalDuration,
    game.substitutionIntervalMinutes,
    existingPlaytime,
    game.maxConsecutiveShifts ?? 2,
    existingState,
    // Mid-game, so rule (c) does *not* apply: an injury that makes the template
    // unsatisfiable is a committed, coach-owned break. Keeping the template as a soft
    // constraint and flagging the mismatch (§6.6) is better than silently reverting to
    // position-blind for every remaining shift.
    await buildPositionConfig(game, newActive, 'midgame'),
  )

  for (const shiftRes of lineupResults[0]?.shifts ?? []) {
    for (const pid of shiftRes.lineup) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + shiftRes.shiftDuration)
    }
  }

  for (let i = 0; i < allToReplace.length && i < (lineupResults[0]?.shifts.length ?? 0); i++) {
    await db.shifts.update(allToReplace[i].shiftId, {
      lineupJson: JSON.stringify(lineupResults[0].shifts[i].lineup),
    })
  }
}

export async function updateActiveRoster(
  gameId: string,
  newActivePlayerIds: string[],
): Promise<void> {
  const game = await db.games.get(gameId)
  if (!game) return

  await db.games.update(gameId, { activePlayerIds: newActivePlayerIds, injuredPlayerIds: [] })

  const segments = await db.segments.where('gameId').equals(gameId).sortBy('number')
  const allShifts = await db.shifts.where('gameId').equals(gameId).toArray()
  const allSplits = await db.shiftSplits.toArray()

  const completedShiftIds = new Set(allShifts.filter(s => s.status === 'COMPLETED').map(s => s.id))
  const currentShift = allShifts.find(s => s.status === 'CURRENT')
  const currentSegIdx = currentShift
    ? segments.findIndex(s => s.id === currentShift.segmentId)
    : -1

  if (currentSegIdx < 0) {
    // No shift has started, so there is no locked-in playtime to preserve and no
    // "future shifts" to recalculate — the whole plan is still ahead of us. Rebuild
    // it from scratch against the new roster (design.md 4.4 Scenario B). Anything
    // else (active game with no current shift) is left alone.
    if (game.status === 'DRAFT') {
      await recalculateLineups(gameId)
    }
    return
  }

  // Calculate existing playtime from completed shifts. `shiftPlaytime` applies any
  // splits recorded against each shift, so a sub-out player (who is absent from the
  // post-swap lineup) and a sub-in player are both credited their true share.
  const existingPlaytime = new Map<string, number>()
  for (const s of allShifts) {
    if (!completedShiftIds.has(s.id)) continue
    const lineup: string[] = JSON.parse(s.lineupJson)
    const splits = allSplits.filter(sp => sp.shiftId === s.id)

    for (const [pid, mins] of shiftPlaytime(s.startMinute, s.endMinute, lineup, splits)) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + mins)
    }
  }

  for (const pid of newActivePlayerIds) {
    if (!existingPlaytime.has(pid)) existingPlaytime.set(pid, 0)
  }

  // Flatten all remaining shifts for a single generation call (continuous consecutive tracking)
  const currentSegShifts = currentShift
    ? allShifts
        .filter(s => s.segmentId === currentShift.segmentId)
        .sort((a, b) => a.startMinute - b.startMinute)
    : []
  const currentShiftIndex = currentSegShifts.findIndex(s => s.id === currentShift?.id)

  const allToReplace: { shiftId: string; duration: number }[] = []
  for (let si = currentSegIdx; si < segments.length; si++) {
    const segShifts = allShifts
      .filter(s => s.segmentId === segments[si].id)
      .sort((a, b) => a.startMinute - b.startMinute)
    if (segShifts.length === 0) continue
    const isFirst = si === currentSegIdx
    const toReplace = isFirst ? segShifts.slice(currentShiftIndex + 1) : segShifts
    for (const s of toReplace) {
      allToReplace.push({ shiftId: s.id, duration: s.endMinute - s.startMinute })
    }
  }

  if (allToReplace.length === 0) return

  const totalDuration = allToReplace.reduce((sum, s) => sum + s.duration, 0)

  // Build timeline state from completed + current shift so consecutive tracking is preserved
  const shiftsChronological = [...allShifts].sort((a, b) => {
    const siA = segments.findIndex(s => s.id === a.segmentId)
    const siB = segments.findIndex(s => s.id === b.segmentId)
    if (siA !== siB) return siA - siB
    return a.startMinute - b.startMinute
  })
  const stateLineups: string[][] = []
  for (const s of shiftsChronological) {
    if (s.id === currentShift?.id) {
      stateLineups.push(JSON.parse(s.lineupJson))
    } else if (completedShiftIds.has(s.id)) {
      stateLineups.push(JSON.parse(s.lineupJson))
    }
  }
  const existingState = computeTimelineState(newActivePlayerIds, stateLineups)

  const lineupResults = generateLineups(
    newActivePlayerIds,
    1,
    totalDuration,
    game.substitutionIntervalMinutes,
    existingPlaytime,
    game.maxConsecutiveShifts ?? 2,
    existingState,
    await buildPositionConfig(game, newActivePlayerIds, 'midgame'),
  )

  for (const shiftRes of lineupResults[0]?.shifts ?? []) {
    for (const pid of shiftRes.lineup) {
      existingPlaytime.set(pid, (existingPlaytime.get(pid) ?? 0) + shiftRes.shiftDuration)
    }
  }

  for (let i = 0; i < allToReplace.length && i < (lineupResults[0]?.shifts.length ?? 0); i++) {
    await db.shifts.update(allToReplace[i].shiftId, {
      lineupJson: JSON.stringify(lineupResults[0].shifts[i].lineup),
    })
  }
}

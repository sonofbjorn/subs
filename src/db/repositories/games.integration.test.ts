/**
 * End-to-end checks for the playtime and roster-edit fixes, run against a real
 * (in-memory) Dexie database. Regression cover for the bugs catalogued in the
 * README's "Known gaps" section.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Position } from '../../types'
import { db } from '../schema'
import { createGame, startGame, advanceShift, injurySub, updateActiveRoster } from './games'

const teamId = 'team-1'

async function reset() {
  await db.open()
  await db.delete()
  await db.open()
  await db.teams.add({ id: teamId, name: 'Wildcats', createdAt: new Date() })
}

const players = Array.from({ length: 8 }, (_, i) => `p${i}`)

describe('injurySub playtime accounting (integration)', () => {
  beforeEach(reset)

  it('credits the sub-out and sub-in players 50/50, and keeps the split point inside the shift', async () => {
    for (const id of players) await db.players.add({ id, teamId, name: id, isArchived: false })

    // 1 quarter, 20 min, 5 min intervals = 4 shifts
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: players,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
    })
    await startGame(gameId)
    await advanceShift(gameId) // finish shift 1 -> shift 2 is CURRENT

    const shifts = await db.shifts.where('gameId').equals(gameId).sortBy('startMinute')
    expect(shifts.find(s => s.status === 'CURRENT')!.startMinute).toBe(5)

    // Sub in the LAST shift of the period, where the old code produced the worst value.
    await advanceShift(gameId)
    await advanceShift(gameId)
    const current2 = (await db.shifts.where('gameId').equals(gameId).sortBy('startMinute'))
      .find(s => s.status === 'CURRENT')!
    expect(current2.startMinute).toBe(15) // 4th shift: the old code said splitMinute=17

    const lineup: string[] = JSON.parse(current2.lineupJson)
    const out = lineup[0]
    const onBench = players.find(p => !lineup.includes(p))!

    await injurySub(gameId, current2.id, out, onBench)

    const split = await db.shiftSplits.where('shiftId').equals(current2.id).first()
    // Split point must be the shift's true midpoint (15 + 5/2), inside [15, 20].
    expect(split!.minute).toBe(17.5)
    expect(split!.minute).toBeGreaterThanOrEqual(15)
    expect(split!.minute).toBeLessThanOrEqual(20)
  })

  it('splits each subbed shift evenly and conserves total court time', async () => {
    for (const id of players) await db.players.add({ id, teamId, name: id, isArchived: false })
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: players,
      structure: 'HALVES', durationMinutes: 20, substitutionIntervalMinutes: 5,
    })
    await startGame(gameId)

    // Sub twice, at deliberately different positions in the period — including the
    // last shift, which the old `Math.floor((start + end) / 2)` mishandled worst.
    const subs: { shiftId: string; out: string; in: string }[] = []
    for (let i = 0; i < 2; i++) {
      const all = await db.shifts.where('gameId').equals(gameId).toArray()
      const current = all.find(s => s.status === 'CURRENT')!
      const lineup: string[] = JSON.parse(current.lineupJson)
      const activeNow = (await db.games.get(gameId))!.activePlayerIds
      const out = lineup[0]
      const inId = activeNow.find(p => !lineup.includes(p))!
      await injurySub(gameId, current.id, out, inId)
      subs.push({ shiftId: current.id, out, in: inId })
      await advanceShift(gameId)
    }

    const all = await db.shifts.where('gameId').equals(gameId).toArray()
    const allSplits = await db.shiftSplits.toArray()
    const { shiftPlaytime } = await import('../../algorithm/playtime')

    // 1. Every subbed shift is split exactly 50/50, at any position in the period.
    for (const sub of subs) {
      const s = (await db.shifts.get(sub.shiftId))!
      const dur = s.endMinute - s.startMinute
      const splits = allSplits.filter(sp => sp.shiftId === s.id)
      const pt = shiftPlaytime(s.startMinute, s.endMinute, JSON.parse(s.lineupJson), splits)
      expect(pt.get(sub.out)).toBe(dur / 2)
      expect(pt.get(sub.in)).toBe(dur / 2)
    }

    // 2. Total court time is conserved: 5 on court for the whole game, always.
    //    The old code broke this — it credited the injured player a segment offset
    //    (up to 17 min in a 5 min shift) and the replacement nothing at all.
    const total = new Map<string, number>()
    for (const s of all) {
      const splits = allSplits.filter(sp => sp.shiftId === s.id)
      for (const [pid, mins] of shiftPlaytime(
        s.startMinute, s.endMinute, JSON.parse(s.lineupJson), splits,
      )) {
        total.set(pid, (total.get(pid) ?? 0) + mins)
      }
    }
    const totalShiftMinutes = all.reduce((n, s) => n + (s.endMinute - s.startMinute), 0)
    const summed = [...total.values()].reduce((a, b) => a + b, 0)
    expect(summed).toBeCloseTo(totalShiftMinutes * 5, 5)

    // 3. No player is credited with more than the entire game's worth of time.
    for (const [, mins] of total) {
      expect(mins).toBeLessThanOrEqual(totalShiftMinutes)
    }
  })
})

describe('updateActiveRoster on a draft game (integration)', () => {
  beforeEach(reset)

  it('regenerates lineups instead of leaving them stale', async () => {
    for (const id of players) await db.players.add({ id, teamId, name: id, isArchived: false })

    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: players,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
    })

    const before = await db.shifts.where('gameId').equals(gameId).toArray()
    expect(before.length).toBeGreaterThan(0)

    // Deactivate two players pre-game.
    await updateActiveRoster(gameId, players.slice(0, 6))

    const game = await db.games.get(gameId)
    expect(game!.activePlayerIds).toEqual(players.slice(0, 6))

    const after = await db.shifts.where('gameId').equals(gameId).toArray()
    // Shifts were regenerated...
    expect(after.length).toBe(before.length)
    expect(after.every(s => s.status === 'PENDING')).toBe(true)

    // ...and no lineup references a player who is no longer active.
    const active = new Set(game!.activePlayerIds)
    for (const s of after) {
      for (const pid of JSON.parse(s.lineupJson) as string[]) {
        expect(active.has(pid)).toBe(true)
      }
    }
  })
})

describe('lineup template plumbing (integration)', () => {
  beforeEach(reset)

  /** 2G / 3F / 2C — the canonical roster for every position test. */
  const POSITIONED: Array<[string, 'G' | 'F' | 'C']> = [
    ['g1', 'G'], ['g2', 'G'],
    ['f1', 'F'], ['f2', 'F'], ['f3', 'F'],
    ['c1', 'C'], ['c2', 'C'],
  ]
  const ids = POSITIONED.map(([id]) => id)

  async function seedPlayers() {
    for (const [id, position] of POSITIONED) {
      await db.players.add({ id, teamId, name: id, isArchived: false, position })
    }
  }

  function mismatches(lineupJson: string, template: Position[]): number[] {
    const lineup: string[] = JSON.parse(lineupJson)
    const byId = new Map(POSITIONED)
    const out: number[] = []
    lineup.forEach((pid, slot) => {
      const pos = byId.get(pid)
      if (pos !== undefined && pos !== template[slot]) out.push(slot)
    })
    return out
  }

  it('snapshots the template and priority onto the game', async () => {
    await seedPlayers()
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: ids,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
      lineupTemplate: ['G', 'G', 'F', 'F', 'C'], lineupPriority: 'TEMPLATE',
    })
    const game = await db.games.get(gameId)
    expect(game!.lineupTemplate).toEqual(['G', 'G', 'F', 'F', 'C'])
    expect(game!.lineupPriority).toBe('TEMPLATE')
  })

  it('leaves both fields absent when the coach chose no template', async () => {
    // The "No template" preset is a real off switch, and `buildPositionConfig` returns
    // `undefined` for it so the position-blind path runs with no position lookup at
    // all. A stray `lineupPriority` with no template would be harmless but misleading.
    await seedPlayers()
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: ids,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
    })
    const game = await db.games.get(gameId)
    expect(game!.lineupTemplate).toBeUndefined()
    expect(game!.lineupPriority).toBeUndefined()
  })

  it('honors the template on every shift of a TEMPLATE-priority game', async () => {
    await seedPlayers()
    const template: Position[] = ['G', 'G', 'F', 'F', 'C']
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: ids,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
      lineupTemplate: template, lineupPriority: 'TEMPLATE',
    })
    const shifts = await db.shifts.where('gameId').equals(gameId).toArray()
    expect(shifts.length).toBeGreaterThan(0)
    for (const s of shifts) {
      expect(mismatches(s.lineupJson, template), `shift at ${s.startMinute}min`).toEqual([])
    }
  })

  it('keeps the template as a soft constraint after a mid-game injury breaks it', async () => {
    // Rule (c) applies only at create. Mid-game, dropping both centers must NOT revert
    // to the position-blind plan for every remaining shift - the coach's break is
    // committed, and what should be left is a position-aware plan with one unmatchable
    // slot rather than a plan that ignores positions altogether.
    //
    // `Math.random` is pinned because the fallback path runs the greedy, whose slot
    // order comes from a shuffled tiebreaker. Left random, the fallback would satisfy
    // this assertion by luck roughly half the time, which would make the test
    // meaningless in both directions.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await seedPlayers()
    const template: Position[] = ['G', 'G', 'F', 'F', 'C']
    const broken = ids.filter(id => id !== 'c1' && id !== 'c2')

    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: ids,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
      lineupTemplate: template, lineupPriority: 'BALANCED',
    })
    await startGame(gameId)
    await advanceShift(gameId)
    await updateActiveRoster(gameId, broken)

    const future = (await db.shifts.where('gameId').equals(gameId).sortBy('startMinute'))
      .filter(s => s.status === 'PENDING')
    expect(future.length).toBeGreaterThan(0)
    // 2G/3F/0C against a template wanting 2G/2F/1C: the center slot is now impossible,
    // but the four satisfiable slots must still be honored. Asserting on the *slots*
    // rather than on a mismatch count is what makes this discriminate - a plain count
    // of one unavoidable mismatch is true of the fallback plan too.
    for (const s of future) {
      const lineup: string[] = JSON.parse(s.lineupJson)
      const pos = (pid: string) => new Map(POSITIONED).get(pid)
      expect(pos(lineup[0]), `slot 0 of shift at ${s.startMinute}min`).toBe('G')
      expect(pos(lineup[1]), `slot 1 of shift at ${s.startMinute}min`).toBe('G')
    }
    vi.restoreAllMocks()
  })

  it('does fall back to the position-blind plan for the same break at create time', async () => {
    // The contrast that proves the previous test is measuring `phase` and not luck:
    // identical roster, template, priority, and pinned shuffle - only the phase differs,
    // and the slot order comes out structurally different.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    await seedPlayers()
    const template: Position[] = ['G', 'G', 'F', 'F', 'C']
    const broken = ids.filter(id => id !== 'c1' && id !== 'c2')

    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: broken,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
      lineupTemplate: template, lineupPriority: 'BALANCED',
    })
    const shifts = await db.shifts.where('gameId').equals(gameId).sortBy('startMinute')
    // The greedy's slot order carries no positional meaning, so it rotates names
    // through the slots - including a forward sitting in the first guard slot. This is
    // what a silent mid-game fallback would produce.
    const aligned = shifts.filter(s => {
      const l: string[] = JSON.parse(s.lineupJson)
      const pos = (pid: string) => new Map(POSITIONED).get(pid)
      return pos(l[0]) === 'G' && pos(l[1]) === 'G'
    })
    expect(aligned.length, 'create-phase fallback produced position-aligned slots').toBe(0)
    vi.restoreAllMocks()
  })

  it('re-reads positions live, so fixing a mislabeled player changes the next plan', async () => {
    // The template is frozen on the game, but positions are not snapshotted. Correcting
    // a mislabeled center to a guard must show up in the regenerated plan.
    await seedPlayers()
    const template: Position[] = ['G', 'G', 'F', 'F', 'C']
    const gameId = await createGame({
      teamId, name: 'g', activePlayerIds: ids,
      structure: 'QUARTERS', durationMinutes: 20, substitutionIntervalMinutes: 5,
      lineupTemplate: template, lineupPriority: 'TEMPLATE',
    })
    // c1 was mislabeled; it is really a forward.
    await db.players.update('c1', { position: 'F' })
    await updateActiveRoster(gameId, ids) // forces a regeneration through the new path

    const shifts = await db.shifts.where('gameId').equals(gameId).toArray()
    const byId = new Map<string, string>(POSITIONED)
    byId.set('c1', 'F')
    for (const s of shifts) {
      const lineup: string[] = JSON.parse(s.lineupJson)
      const gSlots = lineup.slice(0, 2).every(pid => byId.get(pid) === 'G')
      expect(gSlots, `shift at ${s.startMinute}min did not use the corrected position`).toBe(true)
    }
  })
})

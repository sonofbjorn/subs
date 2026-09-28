/**
 * End-to-end checks for the playtime and roster-edit fixes, run against a real
 * (in-memory) Dexie database. Regression cover for the bugs catalogued in the
 * README's "Known gaps" section.
 */
import { describe, it, expect, beforeEach } from 'vitest'
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

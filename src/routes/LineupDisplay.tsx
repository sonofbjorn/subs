import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Shuffle, Play, Pencil, AlertTriangle, CheckCircle2 } from 'lucide-react'
import type { Player, Position, Shift, Segment } from '../types'
import { db } from '../db/schema'
import { startGame, recalculateLineups } from '../db/repositories/games'
import { slotMismatches, resolveToTemplate } from '../algorithm/positions'
import { gamePlaytime } from '../algorithm/playtime'
import PlaytimeSummary from '../components/PlaytimeSummary'
import Button from '../components/ui/button'
import Card from '../components/ui/card'

export default function LineupDisplay() {
  const { teamId, gameId } = useParams()
  const navigate = useNavigate()

  const game = useLiveQuery(() => gameId ? db.games.get(gameId) : undefined, [gameId])
  const team = useLiveQuery(() => teamId ? db.teams.get(teamId) : undefined, [teamId])
  const segments = useLiveQuery(() => {
    if (!gameId) return Promise.resolve([] as Segment[])
    return db.segments.where('gameId').equals(gameId).sortBy('number')
  }, [gameId])
  const shifts = useLiveQuery(() => {
    if (!gameId) return Promise.resolve([] as Shift[])
    return db.shifts.where('gameId').equals(gameId).toArray()
  }, [gameId])
  const allPlayers = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Player[])
    return db.players.where('teamId').equals(teamId).toArray()
  }, [teamId])
  // `shiftSplits` has no `gameId` index, so this is a table scan narrowed in JS. One
  // scan for the whole game, not one per shift.
  const allSplits = useLiveQuery(() => db.shiftSplits.toArray(), [])

  const [selectedSegment, setSelectedSegment] = useState(0)

  const positions = useMemo(
    () => new Map((allPlayers ?? []).map(p => [p.id, p.position as Position | undefined])),
    [allPlayers],
  )

  // Compliance across the whole game, not just the visible segment. Null when the game
  // has no template, which is the only case where the number is meaningless.
  const compliance = useMemo(() => {
    const t = game?.lineupTemplate
    if (!t || !shifts) return null
    let matching = 0
    for (const s of shifts) {
      const resolved = resolveToTemplate(JSON.parse(s.lineupJson), t, positions)
      if (slotMismatches(resolved, t, positions).length === 0) matching++
    }
    return { matching, total: shifts.length }
  }, [game?.lineupTemplate, shifts, positions])

  if (game === undefined || team === undefined || segments === undefined || shifts === undefined || allPlayers === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500">Loading...</p>
      </div>
    )
  }

  if (!game || !team) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-slate-500">Game not found.</p>
        <Button variant="ghost" onClick={() => navigate('/')} className="mt-2">Back to Teams</Button>
      </div>
    )
  }

  const playerMap = new Map(allPlayers.map(p => [p.id, p.name]))
  const byName = (a: string, b: string) => (playerMap.get(a) ?? '').localeCompare(playerMap.get(b) ?? '')
  const activePlayers = game.activePlayerIds
    .map(id => ({ id, name: playerMap.get(id) ?? 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const currentSegment = segments[selectedSegment]
  const segmentShifts = currentSegment
    ? shifts.filter(s => s.segmentId === currentSegment.id).sort((a, b) => a.startMinute - b.startMinute)
    : []

  // Split-aware, via the same helper the recalculation logic uses, so the summary here
  // and the plan that produced it cannot report different numbers.
  const shiftIds = new Set(shifts.map(s => s.id))
  const splits = (allSplits ?? []).filter(s => shiftIds.has(s.shiftId))
  const { playtime, shiftsPlayed, totalMinutes } = gamePlaytime(
    shifts,
    splits,
    game.activePlayerIds,
  )

  const template = game.lineupTemplate

  async function handleStartGame() {
    if (!gameId || !teamId) return
    await startGame(gameId)
    navigate(`/teams/${teamId}/gameday/${gameId}`)
  }

  async function handleReshuffle() {
    if (!gameId) return
    await recalculateLineups(gameId)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/teams/${teamId}`)} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          {team.name}
        </Button>
        <h1 className="text-2xl font-bold text-slate-900">{game.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {game.structure === 'HALVES' ? '2 Halves' : '4 Quarters'} · {totalMinutes} min total ·
          {game.activePlayerIds.length} players
          <span className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            game.status === 'DRAFT' ? 'bg-amber-100 text-amber-700' :
            game.status === 'ACTIVE' ? 'bg-green-100 text-green-700' :
            'bg-slate-100 text-slate-700'
          }`}>
            {game.status}
          </span>
        </p>
      </header>

      {compliance && (
        <p className={`mb-4 flex items-center gap-1.5 text-sm ${
          compliance.matching === compliance.total ? 'text-emerald-700' : 'text-amber-700'
        }`}>
          {compliance.matching === compliance.total ? (
            <>
              <CheckCircle2 className="h-4 w-4" />
              All {compliance.total} shifts match the template {template!.join(' ')}
            </>
          ) : (
            <>
              <AlertTriangle className="h-4 w-4" />
              {compliance.matching} of {compliance.total} shifts match the template{' '}
              {template!.join(' ')}
            </>
          )}
        </p>
      )}

      <div className="mb-6 flex gap-2 overflow-x-auto">
        {segments.map((seg, i) => (
          <button
            key={seg.id}
            onClick={() => setSelectedSegment(i)}
            className={`rounded-md px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
              selectedSegment === i
                ? 'bg-orange-500 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${seg.status === 'COMPLETED' ? 'opacity-60' : seg.status === 'IN_PROGRESS' ? 'ring-2 ring-orange-300' : ''}`}
          >
            {seg.label}
            {seg.status === 'IN_PROGRESS' && <span className="ml-1.5">●</span>}
          </button>
        ))}
      </div>

      {segmentShifts.length === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-sm text-slate-500">No shifts generated for this segment.</p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-4 py-2 text-left font-medium text-slate-600">Shift</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Time</th>
                <th className="px-4 py-2 text-left font-medium text-slate-600">Players on Court</th>
              </tr>
            </thead>
            <tbody>
              {segmentShifts.map((shift, i) => {
                const lineup: string[] = JSON.parse(shift.lineupJson)
                // With a template the lineup is listed in slot order, because slot order
                // is the only thing that makes a mismatch meaningful. Without one the
                // display stays alphabetical, as it has always been.
                //
                // Resolve first, then judge: a greedy-fallback shift is stored in fairness
                // order, so the markers and the chips have to come from the same
                // arrangement the coach is actually looking at.
                const shown = template
                  ? resolveToTemplate(lineup, template, positions)
                  : [...lineup].sort(byName)
                const mismatched = template
                  ? new Set(slotMismatches(shown, template, positions))
                  : new Set<number>()
                return (
                  <tr key={shift.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-slate-700">{i + 1}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {shift.startMinute}–{shift.endMinute} min
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        {shown.map((pid, idx) => {
                          const own = positions.get(pid)
                          // A flex player has no position of their own, so the honest
                          // label is the slot they are filling this shift - which is
                          // real information, unlike the dot it replaces. A player whose
                          // own position is set always shows it, so a mismatch stays
                          // visible in the chip rather than only in the tooltip.
                          const label = own ?? template![idx]
                          return (
                          <span
                            key={pid}
                            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              mismatched.has(idx)
                                ? 'bg-amber-100 text-amber-800 ring-1 ring-amber-300'
                                : 'bg-orange-100 text-orange-700'
                            }`}
                            title={
                              mismatched.has(idx)
                                ? `In the ${template![idx]} slot, but ${positions.get(pid) ?? 'no position'} — template not matched for this shift`
                                : undefined
                            }
                          >
                            {mismatched.has(idx) && <AlertTriangle className="h-3 w-3" />}
                            {playerMap.get(pid) ?? 'Unknown'}
                            {template && (
                              <span className="font-normal opacity-70">{label}</span>
                            )}
                          </span>
                          )
                        })}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {game.status === 'COMPLETED' ? (
        <div className="mt-6">
          <PlaytimeSummary
            players={activePlayers}
            playtime={playtime}
            totalMinutes={totalMinutes}
            shiftsPerPlayer={shiftsPlayed}
          />
        </div>
      ) : (
        <Card className="mt-6">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">Playing Time</h3>
          <div className="space-y-2">
            {activePlayers.map(({ id, name }) => {
              const minutes = playtime.get(id) ?? 0
              const pct = totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0
              return (
                <div key={id} className="flex items-center gap-3">
                  <span className="w-32 text-sm text-slate-700 truncate">{name}</span>
                  <div className="flex-1">
                    <div className="h-2 rounded-full bg-slate-100">
                      <div
                        className="h-2 rounded-full bg-orange-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                  <span className="w-16 text-right text-xs text-slate-500">{minutes} min</span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <div className="mt-8 flex flex-col gap-3">
        {game.status === 'DRAFT' && (
          <>
            <Button variant="secondary" onClick={handleReshuffle} className="w-full">
              <Shuffle className="mr-1.5 h-4 w-4" />
              Re-shuffle
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/teams/${teamId}/game-setup/select`, {
              state: { editGameId: gameId },
            })} className="w-full">
              <Pencil className="mr-1.5 h-4 w-4" />
              Edit Gameday Roster
            </Button>
            <Button onClick={handleStartGame} size="lg" className="w-full">
              <Play className="mr-1.5 h-4 w-4" />
              Start Game
            </Button>
          </>
        )}
        {game.status === 'ACTIVE' && (
          <Button onClick={() => navigate(`/teams/${teamId}/gameday/${gameId}`)} size="lg" className="w-full">
            <Play className="mr-1.5 h-4 w-4" />
            Resume Game
          </Button>
        )}
      </div>
    </div>
  )
}

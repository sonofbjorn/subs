import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, CheckCircle, RotateCcw, Users, Activity, ChevronRight, Cross, Ambulance } from 'lucide-react'
import type { Player, Shift, Segment } from '../types'
import { db } from '../db/schema'
import { advanceShift, uncompleteShift, injurySub } from '../db/repositories/games'
import Button from '../components/ui/button'
import Card from '../components/ui/card'
import Dialog from '../components/ui/dialog'

export default function GamedayMode() {
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
  const shiftSplits = useLiveQuery(() => db.shiftSplits.toArray())

  const [showSubModal, setShowSubModal] = useState(false)
  const [subTarget, setSubTarget] = useState<string | null>(null)
  const [selectedReplacement, setSelectedReplacement] = useState<string | null>(null)

  if (game === undefined || team === undefined || segments === undefined || shifts === undefined || allPlayers === undefined || shiftSplits === undefined) {
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
  const playerNumberMap = new Map(allPlayers.map(p => [p.id, p.number]))

  const currentSegment = segments.find(s => s.status === 'IN_PROGRESS')
  const allDone = segments.length > 0 && segments.every(s => s.status === 'COMPLETED')

  const currentShift = shifts.find(s => s.status === 'CURRENT')
  const segmentShifts = currentSegment
    ? shifts
        .filter(s => s.segmentId === currentSegment.id)
        .sort((a, b) => a.startMinute - b.startMinute)
    : []
  const completedShiftCount = segmentShifts.filter(s => s.status === 'COMPLETED').length
  const hasCompletedShifts = shifts.some(s => s.status === 'COMPLETED')

  const currentShiftSplits = currentShift
    ? shiftSplits.filter(sp => sp.shiftId === currentShift.id)
    : []
  const subInIds = new Set(currentShiftSplits.map(sp => sp.playerInId))

  const byName = (a: string, b: string) => (playerMap.get(a) ?? '').localeCompare(playerMap.get(b) ?? '')

  const onCourt: string[] = currentShift ? (JSON.parse(currentShift.lineupJson) as string[]).sort(byName) : []
  const onCourtSet = new Set(onCourt)
  const injuredSet = new Set(game!.injuredPlayerIds ?? [])
  const bench = currentShift
    ? game.activePlayerIds.filter(pid => !onCourtSet.has(pid)).sort(byName)
    : []
  const injuredPlayers = [...injuredSet].filter(id => !onCourtSet.has(id)).sort(byName)

  const splitMinutes = currentShift
    ? Math.floor((currentShift.startMinute + currentShift.endMinute) / 2)
    : 0

  const subCandidates = currentShift
    ? game.activePlayerIds.filter(pid => !onCourtSet.has(pid) && !injuredSet.has(pid)).sort(byName)
    : []

  function getPlaytimeTotals(): Map<string, number> {
    const pt = new Map<string, number>()
    for (const shift of shifts!) {
      if (shift.status !== 'COMPLETED') continue
      const lineup: string[] = JSON.parse(shift.lineupJson)
      const dur = shift.endMinute - shift.startMinute
      for (const pid of lineup) {
        pt.set(pid, (pt.get(pid) ?? 0) + dur)
      }
    }
    return pt
  }

  function suggestReplacement(): string {
    const playtime = getPlaytimeTotals()
    let lowest = subCandidates[0]
    let lowestTime = Infinity
    for (const pid of subCandidates) {
      const t = playtime.get(pid) ?? 0
      if (t < lowestTime) {
        lowestTime = t
        lowest = pid
      }
    }
    return lowest
  }

  function openSubModal() {
    setSubTarget(null)
    setSelectedReplacement(suggestReplacement())
    setShowSubModal(true)
  }

  async function handleSubConfirm() {
    if (!subTarget || !selectedReplacement || !currentShift || !gameId) return
    await injurySub(gameId, currentShift.id, subTarget, selectedReplacement)
    setShowSubModal(false)
    setSubTarget(null)
    setSelectedReplacement(null)
  }

  async function handleCompleteShift() {
    if (!gameId) return
    await advanceShift(gameId)
  }

  async function handleUncomplete() {
    if (!gameId) return
    await uncompleteShift(gameId)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/teams/${teamId}/lineup/${gameId}`)} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Gameplan
        </Button>
        <h1 className="text-2xl font-bold text-slate-900">{game.name}</h1>
        <p className="mt-1 text-sm text-slate-500">{team.name} · Gameday Mode</p>
      </header>

      {allDone ? (
        <Card className="py-12 text-center">
          <CheckCircle className="mx-auto mb-3 h-12 w-12 text-green-500" />
          <h2 className="text-lg font-semibold text-slate-900">Game Complete!</h2>
          <p className="mt-1 text-sm text-slate-500">All shifts across all segments have been completed.</p>
          <div className="mt-6 flex justify-center gap-3">
            {hasCompletedShifts && (
              <Button onClick={handleUncomplete}>
                <RotateCcw className="mr-1.5 h-4 w-4" />
                Undo Last Shift
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate(`/teams/${teamId}/lineup/${gameId}`)}>
              View Summary
            </Button>
          </div>
        </Card>
      ) : currentSegment && currentShift ? (
        <>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                {currentSegment.label}
                <span className="ml-2 text-sm font-normal text-slate-500">
                  Shift {completedShiftCount + 1} of {segmentShifts.length}
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                {currentShift.startMinute}–{currentShift.endMinute} min
                {currentShiftSplits.length > 0 && <span className="ml-2 text-orange-500">(substitution occurred)</span>}
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700">
              Active
            </span>
          </div>

          {/* Shift Timeline — moved above bench */}
          <div className="mb-4 space-y-1.5">
            {segmentShifts.map((shift, i) => {
              const lineup: string[] = JSON.parse(shift.lineupJson)
              const isCurrent = shift.id === currentShift.id
              const isCompleted = shift.status === 'COMPLETED'
              const shiftHasSub = shiftSplits.some(sp => sp.shiftId === shift.id)
              return (
                <div
                  key={shift.id}
                  className={`rounded-lg border px-4 py-3 transition-colors ${
                    isCurrent
                      ? 'border-green-300 bg-green-50'
                      : isCompleted
                        ? 'border-slate-200 bg-slate-50'
                        : 'border-slate-200'
                  }`}
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className={`text-xs font-medium ${
                      isCurrent ? 'text-green-700' : isCompleted ? 'text-slate-400' : 'text-slate-500'
                    }`}>
                      Shift {i + 1} · {shift.startMinute}–{shift.endMinute} min
                      {shiftHasSub && !isCompleted && <span className="ml-1.5 text-blue-500">(sub)</span>}
                    </p>
                    {isCompleted && <CheckCircle className="h-3.5 w-3.5 text-slate-400" />}
                    {isCurrent && <ChevronRight className="h-3.5 w-3.5 text-green-600" />}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {[...lineup].sort(byName).map(pid => {
                      const isSub = shiftHasSub && shiftSplits
                        .filter(sp => sp.shiftId === shift.id)
                        .some(sp => sp.playerInId === pid)
                      return (
                        <span
                          key={pid}
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium shadow-sm ${
                            isCurrent
                              ? 'bg-white text-green-800'
                              : isCompleted
                                ? 'bg-white text-slate-400'
                                : 'bg-white text-slate-600'
                          }`}
                        >
                          {playerMap.get(pid) ?? 'Unknown'}
                          {isSub && <span className="text-blue-500">(sub)</span>}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Emergency Sub + Edit Roster buttons */}
          <div className="mb-4 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={openSubModal}>
              <Ambulance className="mr-1.5 h-4 w-4" />
              Emergency Sub
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => {
              if (!gameId) return
              navigate(`/teams/${teamId}/game-setup/select`, {
                state: { editGameId: gameId },
              })
            }}>
              <Activity className="mr-1.5 h-4 w-4" />
              Edit Roster
            </Button>
          </div>

          {/* Bench */}
          <Card className="mb-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Bench</h3>
            {bench.length === 0 ? (
              <p className="text-sm text-slate-400">No players on bench</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {bench.map(pid => (
                  <span
                    key={pid}
                    className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-600"
                  >
                    {playerMap.get(pid) ?? 'Unknown'}
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Injured section */}
          {injuredPlayers.length > 0 && (
            <Card className="mb-4 border-red-200 bg-red-50">
              <h3 className="mb-3 text-sm font-semibold text-red-700">Injured</h3>
              <div className="flex flex-wrap gap-2">
                {injuredPlayers.map(pid => (
                  <span
                    key={pid}
                    className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1.5 text-sm text-red-700"
                  >
                    <Cross className="h-3.5 w-3.5" />
                    {playerMap.get(pid) ?? 'Unknown'}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {/* Action buttons */}
          <div className="mt-2 flex flex-col gap-3">
            <Button onClick={handleCompleteShift} size="lg" className="w-full">
              <CheckCircle className="mr-1.5 h-5 w-5" />
              Complete Shift {completedShiftCount + 1}
            </Button>
            {hasCompletedShifts && (
              <Button variant="secondary" onClick={handleUncomplete} className="w-full">
                <RotateCcw className="mr-1.5 h-4 w-4" />
                Un-complete Last Shift
              </Button>
            )}
          </div>
        </>
      ) : currentSegment && !currentShift ? (
        <Card className="py-12 text-center">
          <p className="text-sm text-slate-500">{currentSegment.label} has no shifts.</p>
          <Button variant="ghost" onClick={() => navigate(`/teams/${teamId}/lineup/${gameId}`)} className="mt-3">
            Go to Lineup
          </Button>
        </Card>
      ) : (
        <Card className="py-12 text-center">
          <Users className="mx-auto mb-3 h-12 w-12 text-slate-300" />
          <p className="text-sm text-slate-500">No active segment. Start the game from the Lineup screen.</p>
          <Button variant="ghost" onClick={() => navigate(`/teams/${teamId}/lineup/${gameId}`)} className="mt-3">
            Go to Lineup
          </Button>
        </Card>
      )}

      {/* Emergency Sub Modal */}
      <Dialog
        open={showSubModal}
        onClose={() => { setShowSubModal(false); setSubTarget(null); setSelectedReplacement(null) }}
        title="Emergency Substitution"
        actions={
          <>
            <Button variant="secondary" onClick={() => { setShowSubModal(false); setSubTarget(null); setSelectedReplacement(null) }}>Cancel</Button>
            <Button onClick={handleSubConfirm} disabled={!subTarget || !selectedReplacement}>Confirm Sub</Button>
          </>
        }
      >
        <div className="space-y-5">
          {/* On Court — pick player to sub out */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-700">Sub Out</h4>
            <div className="space-y-1.5">
              {onCourt.map(pid => (
                <button
                  key={pid}
                  onClick={() => setSubTarget(pid)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    subTarget === pid
                      ? 'border-red-400 bg-red-50'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">
                    {playerNumberMap.get(pid)?.toString() ?? '?'}
                  </div>
                  <span className="text-sm font-medium text-slate-900">{playerMap.get(pid) ?? 'Unknown'}</span>
                  {subInIds.has(pid) && (
                    <span className="ml-auto inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                      Sub
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Replacement — pick who comes in */}
          <div>
            <h4 className="mb-2 text-sm font-medium text-slate-700">Replacement</h4>
            {subCandidates.length === 0 ? (
              <p className="text-sm text-slate-400">No available replacements.</p>
            ) : (
              <div className="space-y-1.5">
                {subCandidates.map(pid => (
                  <button
                    key={pid}
                    onClick={() => setSelectedReplacement(pid)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      selectedReplacement === pid
                        ? 'border-orange-400 bg-orange-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    } ${pid === suggestReplacement() && selectedReplacement !== pid ? 'ring-1 ring-orange-200' : ''}`}
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-600">
                      {playerNumberMap.get(pid)?.toString() ?? '?'}
                    </div>
                    <span className="text-sm text-slate-900">{playerMap.get(pid) ?? 'Unknown'}</span>
                    {pid === suggestReplacement() && (
                      <span className="ml-auto text-xs text-orange-500">Suggested</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {subTarget && selectedReplacement && (
            <p className="text-sm text-slate-500">
              Shift time will be split 50/50 ({splitMinutes} min each).
            </p>
          )}
        </div>
      </Dialog>
    </div>
  )
}

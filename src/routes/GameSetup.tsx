import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Clock, AlertTriangle } from 'lucide-react'
import type { GameStructure, LineupPriority, LineupTemplate, Player } from '../types'
import { db } from '../db/schema'
import Button from '../components/ui/button'
import Card from '../components/ui/card'
import Input from '../components/ui/input'
import { LineupTemplateEditor } from '../components/positions'
import { PRIORITY_LABELS } from '../lib/positions'

export default function GameSetup() {
  const { teamId } = useParams()
  const navigate = useNavigate()

  const team = useLiveQuery(() => teamId ? db.teams.get(teamId) : undefined, [teamId])
  const allPlayers = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Player[])
    return db.players.where('teamId').equals(teamId).toArray()
  }, [teamId])

  const defaultName = new Date().toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })

  const [gameName, setGameName] = useState(defaultName)
  const [structure, setStructure] = useState<GameStructure>('QUARTERS')
  const [duration, setDuration] = useState(10)
  const [interval, setInterval] = useState(5)
  const [maxConsecutive, setMaxConsecutive] = useState(2)
  const [template, setTemplate] = useState<LineupTemplate | undefined>(undefined)
  const [priority, setPriority] = useState<LineupPriority>('BALANCED')
  const [seeded, setSeeded] = useState(false)

  // Seed the template controls from the team default exactly once, when the team
  // finishes loading. Done during render rather than in an effect so the first paint
  // already shows the team default and there is no cascading re-render; the `seeded`
  // latch is what stops it from stomping on an edit if the team row re-emits from
  // Dexie's live query.
  if (team && !seeded) {
    setTemplate(team.defaultLineupTemplate)
    setPriority(team.defaultLineupPriority ?? 'BALANCED')
    setSeeded(true)
  }

  if (team === undefined || allPlayers === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500">Loading...</p>
      </div>
    )
  }

  if (!team) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-slate-500">Team not found.</p>
        <Button variant="ghost" onClick={() => navigate('/')} className="mt-2">Back to Teams</Button>
      </div>
    )
  }

  const activePlayers = allPlayers.filter(p => !p.isArchived)
  const activePlayerCount = activePlayers.length
  const notEnoughPlayers = activePlayerCount < 5

  // Best-effort coverage against the whole active roster. The authoritative check runs
  // on the next screen, which is the first to know which players are actually active
  // for this game — a coach can easily drop the only center from the selection.
  const counts = { G: 0, F: 0, C: 0 } as Record<'G' | 'F' | 'C', number>
  const flexCount = activePlayers.filter(p => {
    if (p.position) { counts[p.position]++; return false }
    return true
  }).length
  const uncovered = template
    ? (['G', 'F', 'C'] as const).filter(
        pos => template.filter(t => t === pos).length > counts[pos] + flexCount,
      )
    : []

  const segmentLabel = structure === 'HALVES' ? 'half' : 'quarter'
  const segmentCount = structure === 'HALVES' ? 2 : 4
  const totalMinutes = duration * segmentCount
  const shiftsPerSegment = Math.floor(duration / interval)
  const showWarning = duration % interval !== 0

  function handleNext() {
    navigate(`/teams/${teamId}/game-setup/select`, {
      state: { gameName, structure, duration, interval, maxConsecutive, template, priority },
    })
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/teams/${teamId}`)} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Roster
        </Button>
        <h1 className="text-2xl font-bold text-slate-900">Game Setup</h1>
        <p className="mt-1 text-sm text-slate-500">{team.name}</p>
      </header>

      <div className="space-y-6">
        <Input
          label="Game Name"
          id="game-name"
          value={gameName}
          onChange={e => setGameName(e.target.value)}
        />

        <Card className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">Structure</label>
          <div className="flex gap-2">
            <button
              onClick={() => setStructure('QUARTERS')}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                structure === 'QUARTERS'
                  ? 'bg-orange-500 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Quarters
            </button>
            <button
              onClick={() => setStructure('HALVES')}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                structure === 'HALVES'
                  ? 'bg-orange-500 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Halves
            </button>
          </div>
        </Card>

        <Card className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Duration per {segmentLabel}: <span className="font-bold text-orange-600">{duration} min</span>
          </label>
          <input
            type="range"
            min={5}
            max={30}
            step={1}
            value={duration}
            onChange={e => setDuration(Number(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>5 min</span>
            <span>30 min</span>
          </div>
        </Card>

        <Card className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Substitution every: <span className="font-bold text-orange-600">{interval} min</span>
          </label>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={interval}
            onChange={e => setInterval(Number(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>1 min</span>
            <span>10 min</span>
          </div>
        </Card>

        <Card className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">
            Max consecutive shifts: <span className="font-bold text-orange-600">{maxConsecutive}</span>
          </label>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={maxConsecutive}
            onChange={e => setMaxConsecutive(Number(e.target.value))}
            className="w-full accent-orange-500"
          />
          <div className="flex justify-between text-xs text-slate-400">
            <span>1</span>
            <span>5</span>
          </div>
          <p className="text-xs text-slate-500">
            Soft limit — may be exceeded if not enough substitutes available
          </p>
        </Card>

        <Card className="space-y-3">
          <label className="block text-sm font-medium text-slate-700">Lineup template</label>
          <LineupTemplateEditor value={template} onChange={setTemplate} />
          {uncovered.length > 0 && (
            <p className="flex items-start gap-1.5 text-sm text-amber-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Your roster has no {uncovered.join(' or ')} to cover those
                {uncovered.length === 1 ? ' slot' : ' slots'}. The template won&apos;t be
                matched exactly — you can still create the game and adjust it later.
              </span>
            </p>
          )}
        </Card>

        <Card className="space-y-2">
          <label className="block text-sm font-medium text-slate-700">Priority</label>
          <div className="flex flex-col gap-1.5" role="group" aria-label="Lineup priority">
            {(Object.keys(PRIORITY_LABELS) as LineupPriority[]).map(key => {
              const active = priority === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPriority(key)}
                  aria-pressed={active}
                  className={
                    active
                      ? 'rounded-md bg-orange-500 px-3 py-2 text-left text-sm font-medium text-white'
                      : 'rounded-md bg-white px-3 py-2 text-left text-sm text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
                  }
                >
                  <span className="block font-medium">{PRIORITY_LABELS[key].label}</span>
                  <span className={active ? 'block text-xs text-orange-100' : 'block text-xs text-slate-500'}>
                    {PRIORITY_LABELS[key].help}
                  </span>
                </button>
              )
            })}
          </div>
        </Card>

        <Card className="space-y-2 bg-slate-50">
          <h3 className="text-sm font-semibold text-slate-700">Summary</h3>
          <div className="space-y-1 text-sm text-slate-600">
            <p>{segmentCount} {segmentLabel}{segmentCount > 1 ? 's' : ''} × {duration} min = {totalMinutes} min total</p>
            <p>~{shiftsPerSegment} shifts per {segmentLabel} ({interval} min each)</p>
            <p>Max {maxConsecutive} consecutive shifts · {activePlayerCount} active player{activePlayerCount !== 1 ? 's' : ''} on roster</p>
            <p>
              {template
                ? `Template ${template.join(' ')} · ${PRIORITY_LABELS[priority].label}`
                : 'No template · lineups by playing time only'}
            </p>
          </div>
          {notEnoughPlayers && (
            <p className="flex items-center gap-1.5 text-sm text-red-500">
              <AlertTriangle className="h-4 w-4" />
              Need at least 5 active players. Add more to your roster first.
            </p>
          )}
          {showWarning && (
            <p className="flex items-center gap-1.5 text-sm text-amber-600">
              <Clock className="h-4 w-4" />
              Shifts don't divide evenly into game length — last shift may be shorter
            </p>
          )}
        </Card>

        <Button onClick={handleNext} size="lg" className="w-full" disabled={notEnoughPlayers}>
          Select Active Players
        </Button>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import type { Player, GameStructure, Game } from '../types'
import { db } from '../db/schema'
import { createGame, updateActiveRoster } from '../db/repositories/games'
import Button from '../components/ui/button'
import Card from '../components/ui/card'

interface SetupLocationState {
  gameName: string
  structure: GameStructure
  duration: number
  interval: number
}

interface EditLocationState {
  editGameId: string
}

type PageState = SetupLocationState | EditLocationState

export default function ActivePlayerSelect() {
  const { teamId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as PageState | null

  const team = useLiveQuery(() => teamId ? db.teams.get(teamId) : undefined, [teamId])
  const allPlayers = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Player[])
    return db.players.where('teamId').equals(teamId).toArray()
  }, [teamId])

  const isEdit = state !== null && 'editGameId' in state
  const gameId = isEdit ? (state as EditLocationState).editGameId : null

  const existingGame = useLiveQuery(() => {
    if (!gameId) return Promise.resolve(undefined as Game | undefined)
    return db.games.get(gameId)
  }, [gameId])

  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    if (selectedIds !== null) return
    if (isEdit && existingGame) {
      setSelectedIds(new Set(existingGame.activePlayerIds))
    } else if (!isEdit && state) {
      setSelectedIds(new Set())
    }
  }, [selectedIds, isEdit, existingGame, state])

  if (!state) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-slate-500">No configuration found.</p>
        <Button variant="ghost" onClick={() => navigate(`/teams/${teamId}/game-setup`)} className="mt-2">Back to Setup</Button>
      </div>
    )
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

  if (selectedIds === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500">Loading...</p>
      </div>
    )
  }

  const ids = selectedIds
  const activePlayers = allPlayers.filter(p => !p.isArchived)
  const archivedPlayers = allPlayers.filter(p => p.isArchived)

  function togglePlayer(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev ?? ids)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(activePlayers.map(p => p.id)))
  }

  function deselectAll() {
    setSelectedIds(new Set())
  }

  async function handleCreate() {
    if (!teamId || ids.size < 5) return
    const config = state as SetupLocationState
    const newGameId = await createGame({
      teamId,
      name: config.gameName,
      activePlayerIds: Array.from(ids),
      structure: config.structure,
      durationMinutes: config.duration,
      substitutionIntervalMinutes: config.interval,
    })
    navigate(`/teams/${teamId}/lineup/${newGameId}`)
  }

  async function handleSaveEdit() {
    if (!gameId || ids.size < 5) return
    await updateActiveRoster(gameId, Array.from(ids))
    navigate(`/teams/${teamId}/gameday/${gameId}`)
  }

  function handleBack() {
    if (isEdit) {
      navigate(`/teams/${teamId}/gameday/${gameId}`)
    } else {
      navigate(`/teams/${teamId}/game-setup`)
    }
  }

  const config = state as SetupLocationState
  const title = isEdit ? 'Edit Gameday Roster' : 'Active Players'
  const subtitle = isEdit ? `${team.name}` : `${team.name} &middot; ${config.gameName ?? ''}`

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <Button variant="ghost" size="sm" onClick={handleBack} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          {isEdit ? 'Gameday' : 'Game Setup'}
        </Button>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold">{ids.size}</span> of {activePlayers.length} selected
          {ids.size < 5 && <span className="ml-1 text-amber-600">(minimum 5)</span>}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={selectAll}>Select All</Button>
          <Button variant="ghost" size="sm" onClick={deselectAll}>Deselect All</Button>
        </div>
      </div>

      {activePlayers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 py-16">
          <p className="text-sm text-slate-500">No players on the roster.</p>
          <Button variant="ghost" onClick={() => navigate(`/teams/${teamId}`)} className="mt-2">Add players</Button>
        </div>
      ) : (
        <div className="space-y-2">
          {activePlayers.map(player => (
            <Card
              key={player.id}
              className={`flex cursor-pointer items-center justify-between py-3 transition-colors ${
                ids.has(player.id) ? 'border-orange-300 bg-orange-50' : ''
              }`}
              onClick={() => togglePlayer(player.id)}
            >
              <div className="flex items-center gap-3">
                {player.number !== undefined && (
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                    ids.has(player.id) ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {player.number}
                  </span>
                )}
                <span className={`text-sm font-medium ${
                  ids.has(player.id) ? 'text-slate-900' : 'text-slate-600'
                }`}>
                  {player.name}
                </span>
              </div>
              <div className={`h-5 w-5 rounded border-2 ${
                ids.has(player.id)
                  ? 'flex items-center justify-center border-orange-500 bg-orange-500'
                  : 'border-slate-300'
              }`}>
                {ids.has(player.id) && (
                  <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {archivedPlayers.length > 0 && (
        <section className="mt-6">
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
          >
            {showArchived ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Archived ({archivedPlayers.length})
          </button>
          {showArchived && (
            <div className="mt-2 space-y-2">
              {archivedPlayers.map(player => (
                <Card key={player.id} className="flex items-center justify-between py-3 opacity-60">
                  <div className="flex items-center gap-3">
                    {player.number !== undefined && (
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-400">
                        {player.number}
                      </span>
                    )}
                    <span className="text-sm text-slate-500 line-through">{player.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => togglePlayer(player.id)}
                  >
                    Activate
                  </Button>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="mt-8">
        <Button
          size="lg"
          className="w-full"
          disabled={ids.size < 5}
          onClick={isEdit ? handleSaveEdit : handleCreate}
        >
          {ids.size < 5
            ? `Select ${5 - ids.size} more player${5 - ids.size !== 1 ? 's' : ''}`
            : isEdit
              ? `Save Roster (${ids.size} players) — Recalculate Lineups`
              : `Create Game & Generate Plan (${ids.size} players)`}
        </Button>
      </div>
    </div>
  )
}

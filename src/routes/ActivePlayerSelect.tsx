import { useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import type { Player, GameStructure } from '../types'
import { db } from '../db/schema'
import { createGame } from '../db/repositories/games'
import Button from '../components/ui/button'
import Card from '../components/ui/card'

interface LocationState {
  gameName: string
  structure: GameStructure
  duration: number
  interval: number
}

export default function ActivePlayerSelect() {
  const { teamId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as LocationState | null

  const team = useLiveQuery(() => teamId ? db.teams.get(teamId) : undefined, [teamId])
  const allPlayers = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Player[])
    return db.players.where('teamId').equals(teamId).toArray()
  }, [teamId])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)

  if (!state) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-slate-500">No game configuration found.</p>
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

  const config = state
  const activePlayers = allPlayers.filter(p => !p.isArchived)
  const archivedPlayers = allPlayers.filter(p => p.isArchived)

  function togglePlayer(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
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
    if (!teamId || selectedIds.size < 5) return

    const gameId = await createGame({
      teamId,
      name: config.gameName,
      activePlayerIds: Array.from(selectedIds),
      structure: config.structure,
      durationMinutes: config.duration,
      substitutionIntervalMinutes: config.interval,
    })

    navigate(`/teams/${teamId}/lineup/${gameId}`)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/teams/${teamId}/game-setup`)} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Game Setup
        </Button>
        <h1 className="text-2xl font-bold text-slate-900">Active Players</h1>
        <p className="mt-1 text-sm text-slate-500">{team.name} &middot; {config.gameName}</p>
      </header>

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-slate-600">
          <span className="font-semibold">{selectedIds.size}</span> of {activePlayers.length} selected
          {selectedIds.size < 5 && <span className="ml-1 text-amber-600">(minimum 5)</span>}
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
                selectedIds.has(player.id) ? 'border-orange-300 bg-orange-50' : ''
              }`}
              onClick={() => togglePlayer(player.id)}
            >
              <div className="flex items-center gap-3">
                {player.number !== undefined && (
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                    selectedIds.has(player.id) ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-600'
                  }`}>
                    {player.number}
                  </span>
                )}
                <span className={`text-sm font-medium ${
                  selectedIds.has(player.id) ? 'text-slate-900' : 'text-slate-600'
                }`}>
                  {player.name}
                </span>
              </div>
              <div className={`h-5 w-5 rounded border-2 ${
                selectedIds.has(player.id)
                  ? 'flex items-center justify-center border-orange-500 bg-orange-500'
                  : 'border-slate-300'
              }`}>
                {selectedIds.has(player.id) && (
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
                    onClick={() => {
                      togglePlayer(player.id)
                    }}
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
          disabled={selectedIds.size < 5}
          onClick={handleCreate}
        >
          {selectedIds.size < 5
            ? `Select ${5 - selectedIds.size} more player${5 - selectedIds.size !== 1 ? 's' : ''}`
            : `Create Game & Generate Plan (${selectedIds.size} players)`}
        </Button>
      </div>
    </div>
  )
}

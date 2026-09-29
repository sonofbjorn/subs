import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { Plus, ChevronDown, ChevronRight, ArrowLeft, Archive, RotateCcw, Pencil, Play } from 'lucide-react'
import type { LineupPriority, LineupTemplate, Player, Position } from '../types'
import { db } from '../db/schema'
import { addPlayer, updatePlayer, archivePlayer, unarchivePlayer, isDuplicateName } from '../db/repositories/players'
import { setTeamLineupDefaults } from '../db/repositories/teams'
import Button from '../components/ui/button'
import Card from '../components/ui/card'
import Dialog from '../components/ui/dialog'
import Input from '../components/ui/input'
import { LineupTemplateEditor, PositionChip, PositionPicker } from '../components/positions'
import { PRIORITY_LABELS } from '../lib/positions'

export default function RosterList() {
  const { teamId } = useParams()
  const navigate = useNavigate()

  const team = useLiveQuery(() => teamId ? db.teams.get(teamId) : undefined, [teamId])
  const allPlayers = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Player[])
    return db.players.where('teamId').equals(teamId).toArray()
  }, [teamId])

  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<{ id: string; name: string; number?: number; position?: Position } | null>(null)
  const [formName, setFormName] = useState('')
  const [formNumber, setFormNumber] = useState('')
  const [formPosition, setFormPosition] = useState<Position | undefined>(undefined)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const sorted = (allPlayers ?? []).sort((a, b) => a.name.localeCompare(b.name))
  const activePlayers = sorted.filter(p => !p.isArchived)
  const archivedPlayers = sorted.filter(p => p.isArchived)

  // Surfaced inline on the roster so a coach can see at a glance which positions are
  // unstaffed. A template cannot be satisfied by a position nobody plays, and that is
  // much easier to fix here than to debug in Game Setup.
  const unstaffed = (['G', 'F', 'C'] as const).filter(
    p => !activePlayers.some(pl => pl.position === p),
  )

  function resetForm() {
    setFormName('')
    setFormNumber('')
    setFormPosition(undefined)
    setError('')
  }

  function openAdd() {
    resetForm()
    setShowAdd(true)
  }

  function openEdit(player: { id: string; name: string; number?: number; position?: Position }) {
    setFormName(player.name)
    setFormNumber(player.number?.toString() ?? '')
    setFormPosition(player.position)
    setError('')
    setEditTarget(player)
  }

  async function handleSave() {
    const name = formName.trim()
    if (!name) {
      setError('Name is required')
      return
    }
    if (!teamId) return

    const number = formNumber.trim() ? parseInt(formNumber, 10) : undefined
    if (number !== undefined && (isNaN(number) || number < 0 || number > 99)) {
      setError('Number must be between 0 and 99')
      return
    }

    if (editTarget) {
      const dup = await isDuplicateName(teamId, name, editTarget.id)
      if (dup) { setError('A player with this name already exists'); return }
      await updatePlayer(editTarget.id, { name, number, position: formPosition })
      setEditTarget(null)
    } else {
      const dup = await isDuplicateName(teamId, name)
      if (dup) { setError('A player with this name already exists'); return }
      await addPlayer(teamId, name, number, formPosition)
      setShowAdd(false)
    }
    resetForm()
  }

  async function saveTeamDefault(
    template: LineupTemplate | undefined,
    priority: LineupPriority,
  ) {
    if (!teamId) return
    await setTeamLineupDefaults(teamId, template, priority)
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

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8">
        <Button variant="ghost" size="sm" onClick={() => navigate('/')} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Teams
        </Button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900">{team.name}</h1>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate(`/teams/${teamId}/game-setup`)}>
              <Play className="mr-1.5 h-4 w-4" />
              New Game
            </Button>
            <Button onClick={openAdd}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add Player
            </Button>
          </div>
        </div>
      </header>

      {activePlayers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 py-16">
          <p className="mb-2 text-sm font-medium text-slate-700">No players yet</p>
          <p className="mb-6 text-sm text-slate-500">Add players to create your roster</p>
          <Button onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add your first player
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {activePlayers.map(player => (
            <Card key={player.id} className="flex items-center justify-between py-3">
              <div className="flex items-center gap-3">
                {player.number !== undefined && (
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-orange-700">
                    {player.number}
                  </span>
                )}
                <span className="text-sm font-medium text-slate-900">{player.name}</span>
                <PositionChip position={player.position} />
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => openEdit(player)}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={async () => { await archivePlayer(player.id) }}
                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Archive"
                >
                  <Archive className="h-4 w-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {unstaffed.length > 0 && (
        <p className="mt-4 text-xs text-slate-500">
          No {unstaffed.join(' or ')} on this roster. A template that needs those slots
          can&apos;t be filled — players with no position can cover any slot instead.
        </p>
      )}

      {archivedPlayers.length > 0 && (
        <section className="mt-8">
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
                    <PositionChip position={player.position} className="opacity-70" />
                  </div>
                  <button
                    onClick={async () => { await unarchivePlayer(player.id) }}
                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    title="Restore"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}

      <Dialog
        open={showAdd || editTarget !== null}
        onClose={() => { setShowAdd(false); setEditTarget(null); resetForm() }}
        title={editTarget ? 'Edit Player' : 'Add Player'}
        actions={
          <>
            <Button variant="secondary" onClick={() => { setShowAdd(false); setEditTarget(null); resetForm() }}>Cancel</Button>
            <Button onClick={handleSave}>{editTarget ? 'Save' : 'Add'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label="Player Name"
            id="player-name"
            placeholder="e.g., Alex Johnson"
            value={formName}
            onChange={e => { setFormName(e.target.value); setError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
            autoFocus
          />
          <Input
            label="Jersey Number (optional)"
            id="player-number"
            type="number"
            min={0}
            max={99}
            placeholder="0–99"
            value={formNumber}
            onChange={e => { setFormNumber(e.target.value); setError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          />
          <PositionPicker value={formPosition} onChange={setFormPosition} />
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
      </Dialog>

      {activePlayers.length > 0 && (
        <section className="mt-10 border-t border-slate-200 pt-6">
          <h2 className="text-sm font-semibold text-slate-900">Default lineup template</h2>
          <p className="mb-3 mt-1 text-xs text-slate-500">
            Pre-fills every new game for this team. Each game keeps its own settings once
            created, so changing this never rewrites a game that already exists.
          </p>

          <LineupTemplateEditor
            value={team.defaultLineupTemplate}
            onChange={next => saveTeamDefault(next, team.defaultLineupPriority ?? 'BALANCED')}
          />

          <div className="mt-4">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">Priority</span>
            <div className="flex flex-col gap-1.5" role="group" aria-label="Lineup priority">
              {(Object.keys(PRIORITY_LABELS) as LineupPriority[]).map(key => {
                const active = (team.defaultLineupPriority ?? 'BALANCED') === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => saveTeamDefault(team.defaultLineupTemplate, key)}
                    aria-pressed={active}
                    className={
                      active
                        ? 'rounded-md bg-slate-700 px-3 py-2 text-left text-sm font-medium text-white'
                        : 'rounded-md bg-white px-3 py-2 text-left text-sm text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50'
                    }
                  >
                    <span className="block font-medium">{PRIORITY_LABELS[key].label}</span>
                    <span className={active ? 'block text-xs text-slate-300' : 'block text-xs text-slate-500'}>
                      {PRIORITY_LABELS[key].help}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
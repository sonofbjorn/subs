import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { Plus, Trash2 } from 'lucide-react'
import { db } from '../db/schema'
import { createTeam, renameTeam, deleteTeam } from '../db/repositories/teams'
import Button from '../components/ui/button'
import Card from '../components/ui/card'
import Dialog from '../components/ui/dialog'
import Input from '../components/ui/input'

export default function TeamList() {
  const navigate = useNavigate()
  const teams = useLiveQuery(() => db.teams.toArray())

  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  async function handleCreate() {
    if (!createName.trim()) return
    await createTeam(createName.trim())
    setCreateName('')
    setShowCreate(false)
  }

  function startRename(team: { id: string; name: string }) {
    setEditingId(team.id)
    setEditName(team.name)
  }

  async function finishRename() {
    if (!editingId) return
    if (editName.trim()) {
      await renameTeam(editingId, editName.trim())
    }
    setEditingId(null)
  }

  async function handleDelete(id: string) {
    await deleteTeam(id)
    setDeleteTarget(null)
  }

  if (teams === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500">Loading...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <svg className="h-8 w-8 text-orange-500" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
            <circle cx="12" cy="12" r="9" />
            <path d="M5 5a10 10 0 0 0 14 14M5 19a10 10 0 0 0 14-14" />
            <path d="M12 3v18M3 12h18" />
          </svg>
          <h1 className="text-2xl font-bold text-slate-900">Teams</h1>
        </div>
        {teams.length > 0 && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add Team
          </Button>
        )}
      </header>

      {teams.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 py-20">
          <svg className="mb-4 h-12 w-12 text-slate-300" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
            <circle cx="12" cy="12" r="9" />
            <path d="M5 5a10 10 0 0 0 14 14M5 19a10 10 0 0 0 14-14" />
            <path d="M12 3v18M3 12h18" />
          </svg>
          <h2 className="mb-2 text-lg font-semibold text-slate-700">No teams yet</h2>
          <p className="mb-6 text-sm text-slate-500">Create your first team to get started</p>
          <Button size="lg" onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-5 w-5" />
            Create your first team
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {teams.map(team => (
            <Card key={team.id} className="flex items-center justify-between">
              {editingId === team.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onBlur={finishRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') finishRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="flex-1 rounded border border-orange-500 px-2 py-1 text-sm text-slate-900 outline-none focus:ring-1 focus:ring-orange-500"
                />
              ) : (
                <button
                  onClick={() => navigate(`/teams/${team.id}`)}
                  className="flex-1 text-left text-sm font-medium text-slate-900 hover:text-orange-600"
                >
                  {team.name}
                </button>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startRename(team)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="Rename"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                  </svg>
                </button>
                <button
                  onClick={() => setDeleteTarget(team.id)}
                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={showCreate}
        onClose={() => { setShowCreate(false); setCreateName('') }}
        title="Create Team"
        actions={
          <>
            <Button variant="secondary" onClick={() => { setShowCreate(false); setCreateName('') }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!createName.trim()}>Create</Button>
          </>
        }
      >
        <Input
          label="Team Name"
          id="team-name"
          placeholder="e.g., Wildcats"
          value={createName}
          onChange={e => setCreateName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
          autoFocus
        />
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Team?"
        actions={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Delete</Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          This will permanently delete the team and all associated players, games, and history. This cannot be undone.
        </p>
      </Dialog>
    </div>
  )
}

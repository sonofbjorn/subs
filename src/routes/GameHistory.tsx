import { useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, ChevronRight, Plus } from 'lucide-react'
import type { Game, Segment } from '../types'
import { db } from '../db/schema'
import { buildGameHistory, effectiveGameDate } from '../algorithm/gameHistory'
import BasketballIcon from '../components/BasketballIcon'
import Button from '../components/ui/button'
import Card from '../components/ui/card'

/** Status pill colors, matching Lineup Display and Gameday Mode exactly. */
const STATUS_STYLES: Record<Game['status'], string> = {
  DRAFT: 'bg-amber-100 text-amber-700',
  ACTIVE: 'bg-green-100 text-green-700',
  COMPLETED: 'bg-slate-100 text-slate-700',
}

const STATUS_LABELS: Record<Game['status'], string> = {
  DRAFT: 'Draft',
  ACTIVE: 'In progress',
  COMPLETED: 'Played',
}

/**
 * The date a game is filed under, formatted for display.
 *
 * `toLocaleDateString` with no explicit locale or time zone, matching the only other date
 * in the app (`GameSetup`'s default game name). A game predating `startedAt` /
 * `completedAt` shows its creation date and is given no "unknown" marker: the limit is on
 * what was recorded, not on the game, and a badge would imply a defect that isn't there.
 */
function formatGameDate(game: Game): string {
  return effectiveGameDate(game).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function GameHistory() {
  const { teamId } = useParams()
  const navigate = useNavigate()

  const team = useLiveQuery(() => (teamId ? db.teams.get(teamId) : undefined), [teamId])
  const games = useLiveQuery(() => {
    if (!teamId) return Promise.resolve([] as Game[])
    // `teamId` is an index, so this is a range read rather than a table scan.
    return db.games.where('teamId').equals(teamId).toArray()
  }, [teamId])
  const segments = useLiveQuery(async () => {
    if (!teamId) return [] as Segment[]
    // `primaryKeys` on an indexed range, so this is a key read rather than a table scan,
    // and one batched query for the whole page instead of a per-row segment count.
    // Deliberately self-contained: depending on `games` here would make this query's
    // dependency a fresh array on every resolve of the other one.
    const ids = await db.games.where('teamId').equals(teamId).primaryKeys()
    if (ids.length === 0) return [] as Segment[]
    return db.segments.where('gameId').anyOf(ids).toArray()
  }, [teamId])

  const rows = useMemo(() => {
    if (!games || !segments) return []
    const byGame = new Map<string, Segment[]>()
    for (const s of segments) {
      const list = byGame.get(s.gameId)
      if (list) list.push(s)
      else byGame.set(s.gameId, [s])
    }
    return buildGameHistory(games, byGame)
  }, [games, segments])

  if (team === undefined || games === undefined || segments === undefined) {
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

  // A game you navigate away from has no other route back: every `db.games` read in the
  // app is a single `.get(gameId)` from a URL, so this list is the only index of them.
  // An in-progress game goes where the coach would go anyway — straight back into Gameday
  // Mode — rather than to a read-only history screen that would immediately drift.
  function openGame(game: Game) {
    if (!teamId) return
    const path = game.status === 'ACTIVE' ? 'gameday' : 'lineup'
    navigate(`/teams/${teamId}/${path}/${game.id}`)
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/teams/${teamId}`)} className="mb-2 -ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" />
          {team.name}
        </Button>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900">Game History</h1>
          {rows.length > 0 && (
            <Button onClick={() => navigate(`/teams/${teamId}/game-setup`)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Game
            </Button>
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 py-20">
          <BasketballIcon className="mb-4 h-12 w-12 text-slate-300" />
          <h2 className="mb-2 text-lg font-semibold text-slate-700">No games yet</h2>
          <p className="mb-6 text-sm text-slate-500">
            Games you set up will show up here, so you can come back to them
          </p>
          <Button size="lg" onClick={() => navigate(`/teams/${teamId}/game-setup`)}>
            <Plus className="mr-2 h-5 w-5" />
            Set up your first game
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(({ game, segmentCount }) => (
            <Card key={game.id}>
              <button
                onClick={() => openGame(game)}
                className="flex w-full items-center justify-between text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate font-semibold text-slate-900">{game.name}</h2>
                    <span
                      className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[game.status]}`}
                    >
                      {STATUS_LABELS[game.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-500">
                    {formatGameDate(game)}
                    <span className="mx-1.5 text-slate-300">·</span>
                    {game.structure === 'HALVES' ? '2 Halves' : '4 Quarters'}
                    {segmentCount > 0 && (
                      <>
                        <span className="mx-1.5 text-slate-300">·</span>
                        {segmentCount} {segmentCount === 1 ? 'segment' : 'segments'}
                      </>
                    )}
                    <span className="mx-1.5 text-slate-300">·</span>
                    {game.activePlayerIds.length} players
                  </p>
                </div>
                <ChevronRight className="ml-3 h-5 w-5 flex-shrink-0 text-slate-300" />
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

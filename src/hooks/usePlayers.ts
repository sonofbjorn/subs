import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'

export function usePlayers(teamId: string) {
  const players = useLiveQuery(() =>
    db.players.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  return { players, loading: players === undefined }
}

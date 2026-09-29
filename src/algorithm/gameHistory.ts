import type { Game, Segment } from '../types'

/**
 * The time a game is filed under, and the key the history list sorts on.
 *
 * `createdAt` alone is wrong: it is when the coach hit "Create Game", so a game planned
 * on Monday and played on Saturday sorts a week out of place. Each status gets the most
 * meaningful time it actually has — completion for a finished game, tip-off for one in
 * progress, and creation only as a last resort.
 *
 * A game written before these fields existed resolves to `createdAt`, and that is honest:
 * the real play time is unrecoverable, and backfilling `completedAt = createdAt` would be
 * a fabrication stored in a durable field, indistinguishable from a real stamp later.
 */
export function effectiveGameDate(game: Pick<Game, 'completedAt' | 'startedAt' | 'createdAt'>): Date {
  return game.completedAt ?? game.startedAt ?? game.createdAt
}

/** Newest first. Ties break on `createdAt`, then id, so the order is total and stable. */
export function sortByEffectiveDate<T extends Pick<Game, 'id' | 'completedAt' | 'startedAt' | 'createdAt'>>(
  games: readonly T[],
): T[] {
  return [...games].sort((a, b) => {
    const diff = effectiveGameDate(b).getTime() - effectiveGameDate(a).getTime()
    if (diff !== 0) return diff
    const byCreated = b.createdAt.getTime() - a.createdAt.getTime()
    if (byCreated !== 0) return byCreated
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export interface GameListRow {
  game: Game
  /** Segment count for the row's subtitle. 0 when segments are not loaded. */
  segmentCount: number
}

/**
 * A per-team game list, ready to render.
 *
 * The split is the load-bearing part: `DRAFT` games are included, because a draft the
 * coach walked away from is otherwise unreachable — there is no list UI anywhere else in
 * the app, so a game can only be reopened by guessing its URL. A completed-only list
 * would leave that exactly as broken as it is now.
 *
 * Rows carry metadata only. A per-row playtime summary would walk every shift of every
 * game and scan `shiftSplits`, which has no `gameId` index, on every render; the summary
 * is computed on the detail screen where that data is already loaded.
 */
export function buildGameHistory(
  games: readonly Game[],
  segmentsByGame: ReadonlyMap<string, Segment[]>,
): GameListRow[] {
  return sortByEffectiveDate(games).map(game => ({
    game,
    segmentCount: segmentsByGame.get(game.id)?.length ?? 0,
  }))
}

/**
 * Playtime accounting for shifts, including injury substitutions.
 *
 * A `ShiftSplit` records the *position within the segment* at which a substitution
 * happened. Deriving playtime from a split means splitting the shift's duration at
 * that position — it is not itself a duration. `shiftPlaytime` is the single place
 * that conversion happens, so the two call sites in `db/repositories/games.ts`
 * cannot drift apart.
 */

/** The subset of `Shift` needed to compute playtime. */
export interface PlaytimeShift {
  startMinute: number
  endMinute: number
  /** The lineup *after* all substitutions in this shift have been applied. */
  playerIds: string[]
}

/** The subset of `ShiftSplit` needed to compute playtime. */
export interface PlaytimeSplit {
  /** Position within the segment at which the substitution occurred. */
  minute: number
  playerOutId: string
  playerInId: string
}

/** The subset of `Shift` needed to total a whole game's playtime. */
export interface PlaytimeGameShift {
  startMinute: number
  endMinute: number
  lineupJson: string
}

/** Per-player totals for one game, all keyed by player id. */
export interface GamePlaytime {
  /** Minutes played. Every active player is present, including at 0. */
  playtime: Map<string, number>
  /** Shifts in which the player logged more than zero minutes. */
  shiftsPlayed: Map<string, number>
  /** Minutes actually played, summed over shifts — the denominator for a share. */
  totalMinutes: number
}

/**
 * The default split point for a shift: its true midpoint.
 *
 * Kept as an absolute segment position (not an index, not truncated) so that the
 * duration either side of the split is equal, including for odd-length shifts.
 */
export function splitMinuteFor(startMinute: number, endMinute: number): number {
  return startMinute + (endMinute - startMinute) / 2
}

/**
 * Minutes played by each participant in a single shift.
 *
 * Splits are applied in chronological order against `playerIds` (the post-sub
 * lineup), so a player is credited up to the moment they went out and from the
 * moment they came in. Players with no involvement get the full shift.
 *
 * Returns only players who actually logged time, so callers can add this map
 * straight into an accumulator. A player subbed out at the very start of a shift
 * is absent from the result (they played zero minutes); a player subbed in at the
 * very end likewise contributes nothing.
 */
export function shiftPlaytime(
  startMinute: number,
  endMinute: number,
  playerIds: string[],
  splits: readonly PlaytimeSplit[],
): Map<string, number> {
  const ordered = splits
    .filter(s => s.minute >= startMinute && s.minute <= endMinute)
    .sort((a, b) => a.minute - b.minute)

  const minutes = new Map<string, number>()
  // When each participant entered the shift; absent means "since the start".
  const enteredAt = new Map<string, number>()

  // Anyone in the final lineup who was never substituted in was there from the whistle.
  for (const pid of playerIds) {
    if (!ordered.some(s => s.playerInId === pid)) {
      enteredAt.set(pid, startMinute)
    }
  }

  for (const split of ordered) {
    const outSince = enteredAt.get(split.playerOutId) ?? startMinute
    minutes.set(split.playerOutId, (minutes.get(split.playerOutId) ?? 0) + (split.minute - outSince))
    // They are off court for the remainder, so they must not be tallied again below.
    // (Relevant when someone is subbed back in later in the same shift.)
    enteredAt.delete(split.playerOutId)
    enteredAt.set(split.playerInId, split.minute)
  }

  for (const [pid, from] of enteredAt) {
    minutes.set(pid, (minutes.get(pid) ?? 0) + (endMinute - from))
  }

  return minutes
}

/**
 * Totals a whole game's playtime, split-aware.
 *
 * The single place the UI derives playtime from stored shifts, for the same reason
 * `shiftPlaytime` is the single place a shift's is: the two display loops this replaced
 * each reimplemented the walk and neither applied substitutions, so a game containing an
 * injury sub reported the sub-out player at 0 minutes and the sub-in player at the full
 * shift. `injurySub` rewrites the shift's lineup in place, so the sub-out player is not
 * merely misweighted — they are absent from the shift altogether.
 *
 * Every active player appears in both maps, including at zero. That is not tidiness: a
 * player who never got on court is the most informative row in a summary, and dropping
 * them would let a lockout look like perfect participation (§4.5.7).
 *
 * `totalMinutes` is the time *actually played*, summed over shifts. It is deliberately
 * not `segments × durationMinutes`, which is the configured maximum: a game whose final
 * shift was shortened would report shares summing past 100%.
 */
export function gamePlaytime(
  shifts: readonly PlaytimeGameShift[],
  splits: readonly PlaytimeSplit[],
  activePlayerIds: readonly string[],
): GamePlaytime {
  const playtime = new Map<string, number>()
  const shiftsPlayed = new Map<string, number>()
  for (const pid of activePlayerIds) {
    playtime.set(pid, 0)
    shiftsPlayed.set(pid, 0)
  }

  let totalMinutes = 0
  for (const shift of shifts) {
    totalMinutes += shift.endMinute - shift.startMinute
    const lineup: string[] = JSON.parse(shift.lineupJson)
    for (const [pid, mins] of shiftPlaytime(shift.startMinute, shift.endMinute, lineup, splits)) {
      playtime.set(pid, (playtime.get(pid) ?? 0) + mins)
      // A player who was subbed in and straight back out logged no time, so they were not
      // in that shift for any purpose the summary reports.
      if (mins > 0) shiftsPlayed.set(pid, (shiftsPlayed.get(pid) ?? 0) + 1)
    }
  }

  return { playtime, shiftsPlayed, totalMinutes }
}

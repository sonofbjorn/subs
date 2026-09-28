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
  splits: PlaytimeSplit[],
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

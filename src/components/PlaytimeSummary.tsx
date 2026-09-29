import Card from './ui/card'

interface PlaytimeSummaryProps {
  /**
   * Active players, keyed by id with a display name. Keying by id rather than by name is
   * load-bearing: `isDuplicateName` only blocks *new* duplicates, so two players sharing a
   * name are reachable in an existing roster, and name-keyed maps collapsed them into a
   * single bar with summed minutes.
   */
  players: { id: string; name: string }[]
  playtime: Map<string, number>
  totalMinutes: number
  shiftsPerPlayer: Map<string, number>
}

export default function PlaytimeSummary({ players, playtime, totalMinutes, shiftsPerPlayer }: PlaytimeSummaryProps) {
  // Ties break on name so a re-render never reorders equal-minute players, and so two
  // players with identical minutes appear in a stable, readable order.
  const sorted = [...players].sort(
    (a, b) => (playtime.get(b.id) ?? 0) - (playtime.get(a.id) ?? 0) || a.name.localeCompare(b.name),
  )

  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-slate-700">Plan Summary</h3>
      <div className="space-y-3">
        {sorted.map(({ id, name }) => {
          const minutes = playtime.get(id) ?? 0
          const shifts = shiftsPerPlayer.get(id) ?? 0
          const pct = totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0
          return (
            <div key={id}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium text-slate-900">{name}</span>
                <span className="text-slate-500">{minutes} min ({pct}%) · {shifts} shifts</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-100">
                <div
                  className="h-2.5 rounded-full bg-orange-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

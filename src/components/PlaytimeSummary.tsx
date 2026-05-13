import Card from './ui/card'

interface PlaytimeSummaryProps {
  playerNames: string[]
  playtime: Map<string, number>
  totalMinutes: number
  shiftsPerPlayer: Map<string, number>
}

export default function PlaytimeSummary({ playerNames, playtime, totalMinutes, shiftsPerPlayer }: PlaytimeSummaryProps) {
  const sorted = [...playerNames].sort((a, b) => (playtime.get(b) ?? 0) - (playtime.get(a) ?? 0))

  return (
    <Card>
      <h3 className="mb-4 text-sm font-semibold text-slate-700">Plan Summary</h3>
      <div className="space-y-3">
        {sorted.map(name => {
          const minutes = playtime.get(name) ?? 0
          const shifts = shiftsPerPlayer.get(name) ?? 0
          const pct = totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0
          return (
            <div key={name}>
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

import { useMemo } from 'react'
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import type { LineupPriority, Position } from '../types'
import { templateDiagnostics, shouldUseSolver, type TemplateDiagnosis } from '../algorithm/positions'
import { PRIORITY_LABELS } from '../lib/positions'

const NAME: Record<Position, string> = { G: 'Guards', F: 'Forwards', C: 'Centers' }
const SINGULAR: Record<Position, string> = { G: 'guard', F: 'forward', C: 'center' }

/**
 * True when following the template would hand some position group a materially
 * different share of the game than equal time would.
 *
 * Threshold is deliberately loose. The aim is to name the rosters where the split is
 * obviously lopsided (one group always on, another always off), not to catch every
 * roster where it differs by a shift.
 */
function distortingPositions(
  d: TemplateDiagnosis,
  playerCount: number,
  template: readonly Position[],
): Position[] {
  const equalShare = playerCount > 0 ? 5 / playerCount : 0
  const positions = new Set(template)
  return (['G', 'F', 'C'] as const).filter(
    p => positions.has(p) && Math.abs(d.shares[p] - equalShare) > 0.1,
  )
}

export interface TemplateDiagnosticsPanelProps {
  activePlayerIds: string[]
  positions: Map<string, Position | undefined>
  template: readonly Position[]
  priority: LineupPriority
  onPriorityChange?: (next: LineupPriority) => void
}

/**
 * Create-phase template check. Purely informational: every condition here is
 * navigable, and none of them blocks game creation. A hard block would strand a coach
 * at the sideline with no way to start, and the degraded plan — closest-achievable
 * lineups plus per-shift mismatch markers — is more useful than a refusal.
 *
 * Each condition offers the mode that *provably* changes the outcome. That is not
 * always BALANCED: under an unsatisfiable template, path-selection rule (c) makes
 * BALANCED fall back to the position-blind greedy, so offering it would be a no-op
 * dressed as a fix. Lockouts and saturated groups are similar — no solver can seat a
 * benched position or relieve a group pinned to 100%, so only EQUAL_TIME helps.
 */
export default function TemplateDiagnosticsPanel({
  activePlayerIds,
  positions,
  template,
  priority,
  onPriorityChange,
}: TemplateDiagnosticsPanelProps) {
  const d = useMemo(
    () => templateDiagnostics(activePlayerIds, positions, template as Position[]),
    [activePlayerIds, positions, template],
  )
  const distorting = useMemo(
    () => distortingPositions(d, activePlayerIds.length, template),
    [d, activePlayerIds.length, template],
  )

  const remedies: Array<{ priority: LineupPriority; label: string }> = []
  if (!d.satisfiable || d.lockoutPositions.length > 0 || d.saturatedPositions.length > 0) {
    remedies.push({ priority: 'EQUAL_TIME', label: 'Use equal time instead' })
  } else if (distorting.length > 0) {
    remedies.push({ priority: 'BALANCED', label: 'Use Balanced instead' })
  }
  const remedy = remedies[0]

  // What the generator will actually do, as opposed to what was asked for. On the
  // create screen BALANCED silently degrades to the position-blind plan when the
  // template cannot be filled (path-selection rule (c)), so saying "Balanced" there
  // would be describing a mode that will not run.
  const effective = useMemo(
    () => shouldUseSolver(activePlayerIds, positions, template as Position[], priority, 'create'),
    [activePlayerIds, positions, template, priority],
  )
  const degraded = !effective

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        Template {template.join(' ')} · {PRIORITY_LABELS[priority].label}
        {degraded && (
          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
            running position-blind
          </span>
        )}
      </div>

      {!d.satisfiable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            No {d.shortPositions.map(p => SINGULAR[p]).join(' or ')} on the active roster
          </p>
          <p className="mt-1 text-xs text-amber-700">
            The template asks for {d.shortPositions.map(p => `${template.filter(t => t === p).length} ${SINGULAR[p]}`).join(' and ')}
            {' '}and the selection can&apos;t supply {'it'}. Lineups will be built as close
            to the template as the roster allows. You can still create the game.
          </p>
        </div>
      )}

      {d.satisfiable && d.lockoutPositions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            {d.lockoutPositions.map(p => NAME[p]).join(' and ')} will never play
          </p>
          <p className="mt-1 text-xs text-amber-700">
            The template has no {SINGULAR[d.lockoutPositions[0]]} slot, so anyone at that
            position is benched for the whole game.
          </p>
        </div>
      )}

      {d.satisfiable && d.saturatedPositions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            {d.saturatedPositions.map(p => NAME[p]).join(' and ')} pinned to 100% of the game
          </p>
          <p className="mt-1 text-xs text-amber-700">
            There are exactly as many {SINGULAR[d.saturatedPositions[0]]}
            {d.saturatedPositions.length > 1 ? 's' : ''} as the template has
            {' '}{SINGULAR[d.saturatedPositions[0]]} slot{d.saturatedPositions.length > 1 ? 's' : ''},
            so none of them can ever rest. No lineup mode can fix this — the template
            itself is the cause.
          </p>
        </div>
      )}

      {d.satisfiable && d.lockoutPositions.length === 0 && d.saturatedPositions.length === 0 && distorting.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            Template will change playing time
          </p>
          <p className="mt-1 text-xs text-amber-700">
            Under this template{' '}
            {distorting.map(p => (
              <span key={p} className="mr-2 inline-block">
                {NAME[p]} ≈ {Math.round(d.shares[p] * 100)}% of the game
              </span>
            ))}
            versus {Math.round((5 / Math.max(activePlayerIds.length, 1)) * 100)}% for everyone
            under equal time. Balanced will trade the two off.
          </p>
        </div>
      )}

      {d.satisfiable && distorting.length === 0 && d.lockoutPositions.length === 0 && d.saturatedPositions.length === 0 && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            Every position is covered evenly
          </p>
          <p className="mt-1 text-xs text-emerald-700">
            Each group gets roughly the same share of the game under this template, so
            following it costs nothing in fairness.
          </p>
        </div>
      )}

      {remedy && onPriorityChange && remedy.priority !== priority && (
        <button
          type="button"
          onClick={() => onPriorityChange(remedy.priority)}
          className="w-full rounded-md bg-slate-700 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {remedy.label}
        </button>
      )}

      <p className="flex items-start gap-1.5 text-xs text-slate-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {degraded
          ? 'This template can\u2019t be filled by the active roster, so Balanced will build '
            + 'lineups by playing time alone instead of paying a penalty on every shift. '
            + 'Nothing here blocks game creation.'
          : 'Nothing here blocks game creation. Lineups that can\u2019t match the template '
            + 'are marked with a \u26a0 on the lineup screen.'}
      </p>
    </div>
  )
}

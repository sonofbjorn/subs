import type { LineupTemplate, Position } from '../types'
import { POSITION_TITLES, PRESET_TEMPLATES, nextPosition } from '../lib/positions'
import { cn } from '../lib/utils'

const CHIP_ACTIVE: Record<Position, string> = {
  G: 'bg-blue-100 text-blue-700 ring-blue-300',
  F: 'bg-emerald-100 text-emerald-700 ring-emerald-300',
  C: 'bg-amber-100 text-amber-700 ring-amber-300',
}

/**
 * Read-only position badge. Renders an explicit "Flex" state rather than nothing,
 * because "no position" is a meaningful choice (eligible for any slot) and a blank
 * space would read as missing data instead.
 */
export function PositionChip({ position, className }: { position?: Position; className?: string }) {
  if (position === undefined) {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
          'bg-slate-50 text-slate-500 ring-slate-200',
          className,
        )}
        title="No position set — can play any slot"
      >
        Flex
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
        CHIP_ACTIVE[position],
        className,
      )}
      title={POSITION_TITLES[position]}
    >
      {position}
    </span>
  )
}

/**
 * Single-position selector for one player: Flex / Guard / Forward / Center.
 *
 * Flex is a first-class option rather than a clear button, because it is a real
 * assignment — a player with no position can fill any template slot, which is not the
 * same as being unplayable.
 */
export function PositionPicker({
  value,
  onChange,
  label = 'Position',
}: {
  value: Position | undefined
  onChange: (next: Position | undefined) => void
  label?: string
}) {
  const options: Array<{ key: string; pos?: Position; text: string }> = [
    { key: 'flex', text: 'Flex' },
    { key: 'G', pos: 'G', text: 'G' },
    { key: 'F', pos: 'F', text: 'F' },
    { key: 'C', pos: 'C', text: 'C' },
  ]
  const activeKey = value ?? 'flex'

  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      <div className="flex gap-1.5" role="group" aria-label={label}>
        {options.map(o => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.pos)}
            aria-pressed={activeKey === o.key}
            className={cn(
              'min-w-[3rem] flex-1 rounded-md px-3 py-2 text-sm font-semibold ring-1 ring-inset transition-colors',
              activeKey === o.key
                ? o.pos
                  ? cn('ring-2', CHIP_ACTIVE[o.pos])
                  : 'bg-slate-700 text-white ring-slate-700'
                : 'bg-white text-slate-500 ring-slate-300 hover:bg-slate-50',
            )}
            title={o.pos ? POSITION_TITLES[o.pos] : 'No position — can play any slot'}
          >
            {o.text}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-slate-500">
        {value
          ? `Plays the ${POSITION_TITLES[value]} slot when the template calls for it.`
          : 'No position set — can play any slot in the template.'}
      </p>
    </div>
  )
}

const SLOT_HINT = 'Tap to cycle Guard → Forward → Center'

/** A lineup is always exactly this many slots. */
const SLOT_COUNT = 5

/**
 * The 5-slot lineup template editor. Each chip cycles G → F → C, which is what makes
 * arbitrary templates reachable — the presets below are conveniences, not the only
 * options.
 *
 * `onChange` is called with `undefined` when every slot is empty, so "no template" is
 * distinguishable from "a template of five flex slots" at the storage layer. The two
 * differ: a template of five flex slots is still a template and still runs the solver,
 * whereas no template runs the original position-blind algorithm. Both render as five
 * empty chips, because the distinction only matters to the algorithm and the coach
 * reaches either state by tapping chips, not by a separate control.
 */
export function LineupTemplateEditor({
  value,
  onChange,
  showPresets = true,
}: {
  value: LineupTemplate | undefined
  onChange: (next: LineupTemplate | undefined) => void
  showPresets?: boolean
}) {
  // A stored template always has 5 entries; `undefined` is the empty display state.
  const slots: Array<Position | undefined> =
    value && value.length === SLOT_COUNT ? value : Array.from({ length: SLOT_COUNT }, () => undefined)

  function update(index: number, pos: Position) {
    const next = [...slots] as LineupTemplate
    next[index] = pos
    onChange(next)
  }

  const hasTemplate = value !== undefined && value.length === SLOT_COUNT

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5" role="group" aria-label="Lineup template slots">
        {slots.map((pos, i) => (
          <button
            key={i}
            type="button"
            onClick={() => update(i, nextPosition(pos))}
            className={cn(
              'h-12 w-12 rounded-lg text-base font-bold ring-1 ring-inset transition-colors',
              pos
                ? cn('ring-2', CHIP_ACTIVE[pos])
                : 'bg-white text-slate-400 ring-slate-300 hover:bg-slate-50',
            )}
            title={`Slot ${i + 1}: ${pos ? POSITION_TITLES[pos] : 'any position'} — ${SLOT_HINT}`}
            aria-label={`Slot ${i + 1}, currently ${pos ? POSITION_TITLES[pos] : 'any position'}`}
          >
            {pos ?? '·'}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {showPresets &&
          Object.entries(PRESET_TEMPLATES).map(([name, preset]) => (
            <button
              key={name}
              type="button"
              onClick={() => onChange([...preset] as LineupTemplate)}
              className="rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
            >
              {name}
            </button>
          ))}
        <button
          type="button"
          onClick={() => onChange(undefined)}
          aria-pressed={!hasTemplate}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            hasTemplate
              ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              : 'bg-slate-700 text-white',
          )}
          title="Run every lineup position-blind, ignoring the template"
        >
          No template
        </button>
      </div>

      <p className="text-xs text-slate-500">
        {hasTemplate ? SLOT_HINT : 'No template — lineups are generated by playing time alone.'}
      </p>
    </div>
  )
}

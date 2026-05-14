import { cn } from '../../lib/utils'
import { usePwaInstall } from '../../hooks/usePwaInstall'
import { Download, X } from 'lucide-react'

export default function PwaInstallPrompt() {
  const { canInstall, install, dismiss } = usePwaInstall()

  if (!canInstall) return null

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50',
        'border-t border-orange-200 bg-orange-50 p-4',
      )}
    >
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-white">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1 text-sm">
          <p className="font-medium text-slate-900">Install Subs</p>
          <p className="text-slate-500">Get quick access to your lineups</p>
        </div>
        <button
          onClick={install}
          className="rounded-md bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 transition-colors"
        >
          Install
        </button>
        <button
          onClick={dismiss}
          className="rounded-md p-2 text-slate-400 hover:text-slate-600 transition-colors"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

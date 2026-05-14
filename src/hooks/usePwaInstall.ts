import { useEffect, useState, useCallback } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function usePwaInstall() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [canInstall, setCanInstall] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      setInstallEvent(e as BeforeInstallPromptEvent)
      setCanInstall(true)
    }
    const installedHandler = () => {
      setInstallEvent(null)
      setCanInstall(false)
    }

    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', installedHandler)
    return () => {
      window.removeEventListener('beforeinstallprompt', handler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  const install = useCallback(async () => {
    if (!installEvent) return
    await installEvent.prompt()
    setInstallEvent(null)
    setCanInstall(false)
  }, [installEvent])

  const dismiss = useCallback(() => {
    setInstallEvent(null)
    setCanInstall(false)
  }, [])

  return { canInstall, install, dismiss }
}

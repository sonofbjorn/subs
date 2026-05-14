import { useEffect, useState, useCallback } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua)
}

function detectStandalone(): boolean {
  return 'standalone' in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function usePwaInstall() {
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
  const [canInstall, setCanInstall] = useState(false)
  const isIOS = detectIOS()
  const isStandalone = detectStandalone()

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

  return { canInstall, install, dismiss, isIOS, isStandalone }
}

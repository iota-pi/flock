import { useEffect, useRef, useCallback } from 'react'
import { readAutoLockSettings } from '../api/vault/autoLockStore'
import { lockVault } from '../api/vault'
import { useLoggedIn } from '../state/selectors'

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const

export default function useAutoLock(): void {
  const loggedIn = useLoggedIn()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const performLock = useCallback(() => {
    void lockVault()
  }, [])

  useEffect(() => {
    if (!loggedIn) return

    let isMounted = true

    const setupLockListeners = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }

      const settings = readAutoLockSettings()
      if (settings.mode === 'never') {
        return () => {}
      }

      if (settings.mode === 'focus') {
        const handleVisibilityChange = () => {
          if (document.visibilityState === 'hidden') {
            performLock()
          }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
          document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
      }

      if (settings.mode === 'inactivity') {
        const timeoutMs = Math.max(1, settings.inactivityMinutes) * 60 * 1000

        const resetTimer = () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
          }
          if (isMounted) {
            timerRef.current = setTimeout(performLock, timeoutMs)
          }
        }

        resetTimer()

        for (const event of ACTIVITY_EVENTS) {
          window.addEventListener(event, resetTimer, { passive: true })
        }

        return () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          for (const event of ACTIVITY_EVENTS) {
            window.removeEventListener(event, resetTimer)
          }
        }
      }

      return () => {}
    }

    let cleanup = setupLockListeners()

    const handleSettingsChanged = () => {
      cleanup()
      cleanup = setupLockListeners()
    }

    window.addEventListener('flock-autolock-changed', handleSettingsChanged)
    window.addEventListener('storage', handleSettingsChanged)

    return () => {
      isMounted = false
      cleanup()
      window.removeEventListener('flock-autolock-changed', handleSettingsChanged)
      window.removeEventListener('storage', handleSettingsChanged)
    }
  }, [loggedIn, performLock])
}

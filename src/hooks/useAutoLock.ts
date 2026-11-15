import { useEffect } from 'react'
import { clearManualLock, readAutoLockSettings, subscribeAutoLockSettings } from '../app/vault/autoLockStore'
import { lockVault } from '../app/vault/session'
import { useLoggedIn } from '../state/selectors'

const ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'scroll'] as const
// Moments when the page may have just woken from sleep or a frozen state, so a
// deadline that passed in the meantime must be enforced before anything else
const WAKE_EVENTS = ['focus', 'pageshow'] as const

function setupInactivityLock(timeoutMs: number, lock: () => void): () => void {
  // Timers don't advance while a laptop sleeps or a mobile PWA is frozen, so
  // the deadline is kept against the wall clock and checked whenever the page
  // could have resumed, rather than trusting a single setTimeout
  let lastActivity = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let locked = false

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** Locks and returns true if the deadline has passed, otherwise re-arms the timer */
  const check = (): boolean => {
    if (locked) return true
    const remaining = lastActivity + timeoutMs - Date.now()
    if (remaining <= 0) {
      locked = true
      clearTimer()
      lock()
      return true
    }
    clearTimer()
    timer = setTimeout(check, remaining)
    return false
  }

  const handleActivity = () => {
    // The input that wakes a device mustn't count as activity if the window
    // had already run out while it slept
    if (check()) return
    lastActivity = Date.now()
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      check()
    }
  }

  check()

  for (const event of ACTIVITY_EVENTS) {
    window.addEventListener(event, handleActivity, { passive: true, capture: true })
  }
  for (const event of WAKE_EVENTS) {
    window.addEventListener(event, check)
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    clearTimer()
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, handleActivity, { capture: true })
    }
    for (const event of WAKE_EVENTS) {
      window.removeEventListener(event, check)
    }
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

function setupLockListeners(): () => void {
  const lock = () => {
    void lockVault()
  }

  const settings = readAutoLockSettings()
  if (settings.mode === 'focus') {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lock()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }

  if (settings.mode === 'inactivity') {
    const timeoutMs = Math.max(1, settings.inactivityMinutes) * 60 * 1000
    return setupInactivityLock(timeoutMs, lock)
  }

  return () => {}
}

export default function useAutoLock(): void {
  const loggedIn = useLoggedIn()

  useEffect(() => {
    if (!loggedIn) return
    // Unlocking ends a manual lock, so the next automatic one prompts for biometrics again
    clearManualLock()

    let cleanup = setupLockListeners()

    const unsubscribe = subscribeAutoLockSettings(() => {
      cleanup()
      cleanup = setupLockListeners()
    })

    return () => {
      cleanup()
      unsubscribe()
    }
  }, [loggedIn])
}

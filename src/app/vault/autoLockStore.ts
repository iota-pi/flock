// Flock has always stored the settings under this key. Changing it resets every user's auto-lock setting.
export const AUTO_LOCK_SETTINGS_KEY = 'FlockAutoLockSettings'

/** Dispatched on window when this tab changes the settings ('storage' covers other tabs) */
const AUTO_LOCK_CHANGED_EVENT = 'flock-autolock-changed'

export type AutoLockMode = 'focus' | 'inactivity' | 'never'

export type AutoLockSettings = {
  mode: AutoLockMode
  inactivityMinutes: number
}

export const INACTIVITY_PRESETS = [1, 2, 5, 10, 20, 60] as const

export const DEFAULT_AUTO_LOCK_SETTINGS: AutoLockSettings = {
  mode: 'never',
  inactivityMinutes: 5,
}

export function readAutoLockSettings(): AutoLockSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_AUTO_LOCK_SETTINGS
  try {
    const raw = localStorage.getItem(AUTO_LOCK_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AutoLockSettings>
      if (parsed?.mode && ['focus', 'inactivity', 'never'].includes(parsed.mode)) {
        return {
          mode: parsed.mode,
          inactivityMinutes: typeof parsed.inactivityMinutes === 'number' ? parsed.inactivityMinutes : DEFAULT_AUTO_LOCK_SETTINGS.inactivityMinutes,
        }
      }
    }
  } catch {
    // Return defaults on parse error
  }
  return DEFAULT_AUTO_LOCK_SETTINGS
}

export function writeAutoLockSettings(settings: AutoLockSettings): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(AUTO_LOCK_SETTINGS_KEY, JSON.stringify(settings))
  window.dispatchEvent(new CustomEvent(AUTO_LOCK_CHANGED_EVENT))
}

/** Calls `listener` when the settings change in this tab or another */
export function subscribeAutoLockSettings(listener: () => void): () => void {
  window.addEventListener(AUTO_LOCK_CHANGED_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(AUTO_LOCK_CHANGED_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

/** Set when the user locks the app, so the login page doesn't prompt for biometrics straight away */
const MANUAL_LOCK_KEY = 'flock-manual-lock'

export function markManualLock() {
  sessionStorage.setItem(MANUAL_LOCK_KEY, 'true')
}

/** Whether the user locked the app themselves. Reading it clears it. */
export function consumeManualLock(): boolean {
  const manual = sessionStorage.getItem(MANUAL_LOCK_KEY) === 'true'
  sessionStorage.removeItem(MANUAL_LOCK_KEY)
  return manual
}

export function getAutoLockSummary(settings = readAutoLockSettings()): string {
  switch (settings.mode) {
    case 'focus':
      return 'When app loses focus'
    case 'inactivity':
      return `After ${settings.inactivityMinutes} minute${settings.inactivityMinutes === 1 ? '' : 's'} of inactivity`
    case 'never':
    default:
      return 'Never'
  }
}

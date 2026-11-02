// Flock has always stored the settings under this key. Changing it resets every user's auto-lock setting.
export const AUTO_LOCK_SETTINGS_KEY = 'FlockAutoLockSettings'

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

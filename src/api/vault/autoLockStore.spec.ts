import {
  readAutoLockSettings,
  writeAutoLockSettings,
  clearAutoLockSettings,
  getAutoLockSummary,
  DEFAULT_AUTO_LOCK_SETTINGS,
} from './autoLockStore'
import { getVaultStorageNames } from '../../sync/shared/storageNames'

describe('autoLockStore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns default settings when nothing is in storage', () => {
    expect(readAutoLockSettings()).toEqual(DEFAULT_AUTO_LOCK_SETTINGS)
    expect(getAutoLockSummary()).toBe('Never')
  })

  it('persists and reads back focus loss settings', () => {
    writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    expect(readAutoLockSettings()).toEqual({ mode: 'focus', inactivityMinutes: 5 })
    expect(getAutoLockSummary({ mode: 'focus', inactivityMinutes: 5 })).toBe('When app loses focus')
  })

  it('persists and reads back inactivity settings', () => {
    writeAutoLockSettings({ mode: 'inactivity', inactivityMinutes: 10 })
    expect(readAutoLockSettings()).toEqual({ mode: 'inactivity', inactivityMinutes: 10 })
    expect(getAutoLockSummary({ mode: 'inactivity', inactivityMinutes: 10 })).toBe('After 10 minutes of inactivity')
    expect(getAutoLockSummary({ mode: 'inactivity', inactivityMinutes: 1 })).toBe('After 1 minute of inactivity')
  })

  it('clears auto-lock settings', () => {
    writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    clearAutoLockSettings()
    expect(localStorage.getItem(getVaultStorageNames().autoLockSettingsKey)).toBeNull()
    expect(readAutoLockSettings()).toEqual(DEFAULT_AUTO_LOCK_SETTINGS)
  })

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem(getVaultStorageNames().autoLockSettingsKey, 'invalid-json')
    expect(readAutoLockSettings()).toEqual(DEFAULT_AUTO_LOCK_SETTINGS)
  })
})

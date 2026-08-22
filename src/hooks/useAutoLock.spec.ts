import { act, renderHook } from '@testing-library/react'
import useAutoLock from './useAutoLock'
import * as vault from '../api/vault'
import * as autoLockStore from '../api/vault/autoLockStore'
import { useAppStore } from '../state/store'

describe('useAutoLock hook', () => {
  let lockVaultSpy: any

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    lockVaultSpy = vi.spyOn(vault, 'lockVault').mockResolvedValue(undefined)
    useAppStore.setState({ loggedIn: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does nothing when mode is never', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'never', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000)
    })

    expect(lockVaultSpy).not.toHaveBeenCalled()
  })

  it('locks when app visibility changes to hidden in focus mode', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(lockVaultSpy).toHaveBeenCalledTimes(1)
  })

  it('does not lock when visibility changes to visible in focus mode', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(lockVaultSpy).not.toHaveBeenCalled()
  })

  it('locks after configured inactivity duration in inactivity mode', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'inactivity', inactivityMinutes: 2 })
    renderHook(() => useAutoLock())

    act(() => {
      vi.advanceTimersByTime(1 * 60 * 1000)
    })
    expect(lockVaultSpy).not.toHaveBeenCalled()

    // Activity resets timer
    act(() => {
      window.dispatchEvent(new Event('mousedown'))
    })

    act(() => {
      vi.advanceTimersByTime(1.5 * 60 * 1000)
    })
    expect(lockVaultSpy).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1 * 60 * 1000)
    })
    expect(lockVaultSpy).toHaveBeenCalledTimes(1)
  })

  it('reacts dynamically to custom settings change event', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'never', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    // Switch to focus mode
    autoLockStore.writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    act(() => {
      window.dispatchEvent(new CustomEvent('flock-autolock-changed'))
    })

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(lockVaultSpy).toHaveBeenCalledTimes(1)
  })

  it('does not lock if user is not logged in', () => {
    useAppStore.setState({ loggedIn: false })
    autoLockStore.writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(lockVaultSpy).not.toHaveBeenCalled()
  })
})

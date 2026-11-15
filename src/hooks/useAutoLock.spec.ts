import { act, renderHook } from '@testing-library/react'
import useAutoLock from './useAutoLock'
import * as session from '../app/vault/session'
import * as autoLockStore from '../app/vault/autoLockStore'
import { useAppStore } from '../state/store'

describe('useAutoLock hook', () => {
  let lockVaultSpy: any

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    lockVaultSpy = vi.spyOn(session, 'lockVault').mockResolvedValue(undefined)
    useAppStore.setState({ loggedIn: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ends a manual lock once unlocked, but not while still locked', () => {
    autoLockStore.markManualLock()
    useAppStore.setState({ loggedIn: false })
    const { rerender } = renderHook(() => useAutoLock())
    expect(autoLockStore.isManualLock()).toBe(true)

    act(() => {
      useAppStore.setState({ loggedIn: true })
    })
    rerender()
    expect(autoLockStore.isManualLock()).toBe(false)
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

  describe('after the device sleeps past the deadline', () => {
    // Moves the wall clock without letting timers run, as when a laptop sleeps
    // or a PWA is frozen
    const sleep = (ms: number) => {
      vi.setSystemTime(Date.now() + ms)
    }

    beforeEach(() => {
      autoLockStore.writeAutoLockSettings({ mode: 'inactivity', inactivityMinutes: 2 })
      renderHook(() => useAutoLock())
      sleep(3 * 60 * 1000)
    })

    afterEach(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      })
    })

    it('locks on the waking input rather than counting it as activity', () => {
      act(() => {
        window.dispatchEvent(new Event('keydown'))
      })
      expect(lockVaultSpy).toHaveBeenCalledTimes(1)

      act(() => {
        window.dispatchEvent(new Event('keydown'))
      })
      expect(lockVaultSpy).toHaveBeenCalledTimes(1)
    })

    it('locks when the page becomes visible', () => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      })
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(lockVaultSpy).toHaveBeenCalledTimes(1)
    })

    it('locks on focus or pageshow', () => {
      act(() => {
        window.dispatchEvent(new Event('focus'))
        window.dispatchEvent(new Event('pageshow'))
      })
      expect(lockVaultSpy).toHaveBeenCalledTimes(1)
    })
  })

  it('does not lock on waking if the deadline has not passed', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'inactivity', inactivityMinutes: 2 })
    renderHook(() => useAutoLock())
    vi.setSystemTime(Date.now() + 60 * 1000)

    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('mousedown'))
    })
    expect(lockVaultSpy).not.toHaveBeenCalled()

    // The waking input counted as activity, so the window restarts from it
    act(() => {
      vi.advanceTimersByTime(1.5 * 60 * 1000)
    })
    expect(lockVaultSpy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1 * 60 * 1000)
    })
    expect(lockVaultSpy).toHaveBeenCalledTimes(1)
  })

  it('reacts when the settings change', () => {
    autoLockStore.writeAutoLockSettings({ mode: 'never', inactivityMinutes: 5 })
    renderHook(() => useAutoLock())

    // Switch to focus mode
    act(() => {
      autoLockStore.writeAutoLockSettings({ mode: 'focus', inactivityMinutes: 5 })
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

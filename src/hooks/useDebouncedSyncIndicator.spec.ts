import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedSyncIndicator } from './useDebouncedSyncIndicator'
import { useAppStore } from '../state/store'

describe('useDebouncedSyncIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    act(() => {
      useAppStore.setState({
        activeRequests: 0,
        syncStatus: 'idle',
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('initializes to false when idle and true when syncing', () => {
    const { result: idleResult } = renderHook(() => useDebouncedSyncIndicator(false))
    expect(idleResult.current).toBe(false)

    const { result: syncingResult } = renderHook(() => useDebouncedSyncIndicator(true))
    expect(syncingResult.current).toBe(true)
  })

  it('activates immediately when isSyncing transitions from false to true', () => {
    let syncing = false
    const { result, rerender } = renderHook(() => useDebouncedSyncIndicator(syncing, 200))

    expect(result.current).toBe(false)

    syncing = true
    rerender()

    expect(result.current).toBe(true)
  })

  it('delays deactivation by debounceMs when isSyncing transitions from true to false', () => {
    let syncing = true
    const { result, rerender } = renderHook(() => useDebouncedSyncIndicator(syncing, 200))

    expect(result.current).toBe(true)

    syncing = false
    rerender()

    // Should remain true immediately after transitioning to false
    expect(result.current).toBe(true)

    // Advance halfway through debounce window
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe(true)

    // Advance past the debounce window
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(result.current).toBe(false)
  })

  it('prevents flickering during rapid sync cycles', () => {
    let syncing = false
    const { result, rerender } = renderHook(() => useDebouncedSyncIndicator(syncing, 200))

    expect(result.current).toBe(false)

    // Cycle 1: Request 1 starts
    syncing = true
    rerender()
    expect(result.current).toBe(true)

    // Request 1 finishes 20ms later
    act(() => {
      vi.advanceTimersByTime(20)
    })
    syncing = false
    rerender()
    expect(result.current).toBe(true)

    // Cycle 2: Request 2 starts 30ms later (before 200ms debounce expires)
    act(() => {
      vi.advanceTimersByTime(30)
    })
    syncing = true
    rerender()
    expect(result.current).toBe(true)

    // Request 2 finishes 20ms later
    act(() => {
      vi.advanceTimersByTime(20)
    })
    syncing = false
    rerender()
    expect(result.current).toBe(true)

    // Cycle 3: Request 3 starts 30ms later
    act(() => {
      vi.advanceTimersByTime(30)
    })
    syncing = true
    rerender()
    expect(result.current).toBe(true)

    // Request 3 finishes
    act(() => {
      vi.advanceTimersByTime(20)
    })
    syncing = false
    rerender()
    expect(result.current).toBe(true)

    // Advance past final debounce timer
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe(false)
  })

  it('reads activeRequests and syncStatus from useAppStore when no prop is provided', () => {
    const { result } = renderHook(() => useDebouncedSyncIndicator())
    expect(result.current).toBe(false)

    // Trigger activeRequests in store
    act(() => {
      useAppStore.setState({ activeRequests: 1 })
    })
    expect(result.current).toBe(true)

    // Clear activeRequests in store
    act(() => {
      useAppStore.setState({ activeRequests: 0 })
    })
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe(false)

    // Trigger syncStatus in store
    act(() => {
      useAppStore.setState({ syncStatus: 'syncing' })
    })
    expect(result.current).toBe(true)

    act(() => {
      useAppStore.setState({ syncStatus: 'idle' })
    })
    expect(result.current).toBe(true)

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe(false)
  })

  it('cleans up timeout on unmount', () => {
    let syncing = true
    const { rerender, unmount } = renderHook(() => useDebouncedSyncIndicator(syncing, 200))

    syncing = false
    rerender()

    unmount()

    // Verify advancing timers does not throw or error after unmount
    act(() => {
      vi.advanceTimersByTime(300)
    })
  })
})

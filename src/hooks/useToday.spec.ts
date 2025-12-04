import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getStartOfDay, useToday, __test__ } from './useToday'

describe('useToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __test__.reset()
  })

  afterEach(() => {
    __test__.reset()
    vi.useRealTimers()
  })

  describe('getStartOfDay', () => {
    it('returns midnight of the given date', () => {
      const input = new Date('2025-12-04T14:30:45.123')
      const result = getStartOfDay(input)

      expect(result.getFullYear()).toBe(2025)
      expect(result.getMonth()).toBe(11) // December (0-indexed)
      expect(result.getDate()).toBe(4)
      expect(result.getHours()).toBe(0)
      expect(result.getMinutes()).toBe(0)
      expect(result.getSeconds()).toBe(0)
      expect(result.getMilliseconds()).toBe(0)
    })

    it('returns midnight of current date when no argument', () => {
      vi.setSystemTime(new Date('2025-12-04T14:30:00'))
      const result = getStartOfDay()

      expect(result.getDate()).toBe(4)
      expect(result.getHours()).toBe(0)
    })

    it('does not mutate the input date', () => {
      const input = new Date('2025-12-04T14:30:00')
      const originalTime = input.getTime()
      getStartOfDay(input)

      expect(input.getTime()).toBe(originalTime)
    })
  })

  describe('useToday hook', () => {
    it('returns the start of the current day', () => {
      vi.setSystemTime(new Date('2025-12-04T14:30:00'))
      __test__.reset()

      const { result } = renderHook(() => useToday())

      expect(result.current.getFullYear()).toBe(2025)
      expect(result.current.getMonth()).toBe(11)
      expect(result.current.getDate()).toBe(4)
      expect(result.current.getHours()).toBe(0)
      expect(result.current.getMinutes()).toBe(0)
      expect(result.current.getSeconds()).toBe(0)
    })

    it('updates when the day changes', () => {
      vi.setSystemTime(new Date('2025-12-04T23:59:30'))
      __test__.reset()

      const { result } = renderHook(() => useToday())

      expect(result.current.getDate()).toBe(4)

      // Advance past midnight
      act(() => {
        vi.setSystemTime(new Date('2025-12-05T00:00:30'))
        vi.advanceTimersByTime(1000)
      })

      expect(result.current.getDate()).toBe(5)
    })

    it('does not update if day has not changed', () => {
      vi.setSystemTime(new Date('2025-12-04T10:00:00'))
      __test__.reset()

      const { result } = renderHook(() => useToday())
      const initialToday = result.current

      // Advance time but stay on same day
      act(() => {
        vi.setSystemTime(new Date('2025-12-04T11:00:00'))
        vi.advanceTimersByTime(1000)
      })

      expect(result.current).toBe(initialToday)
    })

    it('shares the same interval across multiple hooks', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval')
      vi.setSystemTime(new Date('2025-12-04T10:00:00'))
      __test__.reset()

      const { result: result1 } = renderHook(() => useToday())
      const { result: result2 } = renderHook(() => useToday())

      // Both hooks should return the same date
      expect(result1.current.getTime()).toBe(result2.current.getTime())

      // Only one interval should have been created
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)

      setIntervalSpy.mockRestore()
    })

    it('cleans up interval when all hooks unmount', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
      vi.setSystemTime(new Date('2025-12-04T10:00:00'))
      __test__.reset()

      const { unmount: unmount1 } = renderHook(() => useToday())
      const { unmount: unmount2 } = renderHook(() => useToday())

      // Interval should not be cleared when only one unmounts
      unmount1()
      expect(clearIntervalSpy).not.toHaveBeenCalled()
      expect(__test__.getListenerCount()).toBe(1)

      // Interval should be cleared when last hook unmounts
      unmount2()
      expect(clearIntervalSpy).toHaveBeenCalled()
      expect(__test__.getListenerCount()).toBe(0)

      clearIntervalSpy.mockRestore()
    })

    it('all hooks update when day changes', () => {
      vi.setSystemTime(new Date('2025-12-04T23:59:30'))
      __test__.reset()

      const { result: result1 } = renderHook(() => useToday())
      const { result: result2 } = renderHook(() => useToday())

      expect(result1.current.getDate()).toBe(4)
      expect(result2.current.getDate()).toBe(4)

      // Advance past midnight
      act(() => {
        vi.setSystemTime(new Date('2025-12-05T00:00:30'))
        vi.advanceTimersByTime(1000)
      })

      expect(result1.current.getDate()).toBe(5)
      expect(result2.current.getDate()).toBe(5)
    })
  })
})

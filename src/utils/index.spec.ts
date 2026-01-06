import { renderHook } from '@testing-library/react'
import {
  capitalise,
  formatDate,
  formatDateAndTime,
  formatTime,
  generateItemId,
  isDefined,
  isSameDay,
  usePrevious,
  useStringMemo,
  useToday,
} from './index'

describe('utils', () => {
  describe('isDefined', () => {
    it('returns true for defined values', () => {
      expect(isDefined(0)).toBe(true)
      expect(isDefined('')).toBe(true)
      expect(isDefined(false)).toBe(true)
      expect(isDefined({})).toBe(true)
    })

    it('returns false for null or undefined', () => {
      expect(isDefined(null)).toBe(false)
      expect(isDefined(undefined)).toBe(false)
    })
  })

  describe('generateItemId', () => {
    it('returns a string', () => {
      const id = generateItemId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)
    })
  })

  describe('formatting', () => {
    const date = new Date(2023, 0, 1, 13, 30) // Jan 1 2023, 1:30 PM

    it('formatDate returns a date string', () => {
      const formatted = formatDate(date)
      expect(formatted).toBe('1/1/2023')
    })

    it('formatTime returns a time string', () => {
      const formatted = formatTime(date)
      expect(formatted).toContain('1:30')
      expect(formatted).toMatch(/pm/i)
    })

    it('formatDateAndTime combines them', () => {
      const formatted = formatDateAndTime(date)
      expect(formatted).toContain(formatDate(date))
      expect(formatted).toContain(formatTime(date))
    })
  })

  describe('isSameDay', () => {
    it('returns true for same day', () => {
      const d1 = new Date(2023, 0, 1, 10, 0)
      const d2 = new Date(2023, 0, 1, 15, 0)
      expect(isSameDay(d1, d2)).toBe(true)
    })

    it('returns false for different days', () => {
      const d1 = new Date(2023, 0, 1)
      const d2 = new Date(2023, 0, 2)
      expect(isSameDay(d1, d2)).toBe(false)
    })
  })

  describe('capitalise', () => {
    it('capitalises the first letter', () => {
      expect(capitalise('flock')).toBe('Flock')
      expect(capitalise('Flock')).toBe('Flock')
    })

    it('handles empty string', () => {
      expect(capitalise('')).toBe('')
    })
  })

  describe('hooks', () => {
    it('useToday returns a date', () => {
      const { result } = renderHook(() => useToday())
      expect(result.current).toBeInstanceOf(Date)
    })

    it('usePrevious returns previous value', () => {
      const { result, rerender } = renderHook(({ value }) => usePrevious(value), {
        initialProps: { value: 1 },
      })

      // On first render, ref is undefined (as assigned in effect runs after render)
      expect(result.current).toBeUndefined()

      rerender({ value: 2 })
      // On second render, ref.current was set to 1
      expect(result.current).toBe(1)

      rerender({ value: 3 })
      expect(result.current).toBe(2)
    })

    it('useStringMemo memoizes based on string join', () => {
      const arr1 = ['a', 'b']
      const arr2 = ['a', 'b'] // Different reference, same content
      const arr3 = ['a', 'c']

      const { result, rerender } = renderHook(({ app }) => useStringMemo(app), {
        initialProps: { app: arr1 },
      })

      const firstResult = result.current
      expect(firstResult).toBe(arr1)

      rerender({ app: arr2 })
      // Should be equal to firstResult because content key matches
      expect(result.current).toBe(firstResult)

      rerender({ app: arr3 })
      // Key changes, so it returns new state
      expect(result.current).toBe(arr3)
    })
  })
})

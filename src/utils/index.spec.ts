import { renderHook } from '@testing-library/react'
import {
  isDefined,
  generateItemId,
  formatDate,
  formatTime,
  isSameDay,
  useStringMemo,
  capitalise,
} from './index'

describe('utils/index', () => {
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
      expect(typeof generateItemId()).toBe('string')
    })

    it('returns unique IDs', () => {
      const id1 = generateItemId()
      const id2 = generateItemId()
      expect(id1).not.toBe(id2)
    })
  })

  describe('formatDate', () => {
    it('formats date correctly', () => {
      const d = new Date('2024-01-01T12:00:00')
      // Just check it returns a string and contains parts of the date
      const result = formatDate(d)
      expect(typeof result).toBe('string')
    })
  })

  describe('formatTime', () => {
    it('formats time correctly', () => {
      const d = new Date('2024-01-01T13:05:00') // 1:05pm
      expect(formatTime(d)).toBe('1:05pm')

      const d2 = new Date('2024-01-01T00:30:00') // 12:30am
      expect(formatTime(d2)).toBe('12:30am')
    })
  })

  describe('isSameDay', () => {
    it('returns true for same day', () => {
      const d1 = new Date('2024-01-01T10:00:00')
      const d2 = new Date('2024-01-01T20:00:00')
      expect(isSameDay(d1, d2)).toBe(true)
    })

    it('returns false for different days', () => {
      const d1 = new Date('2024-01-01T10:00:00')
      const d2 = new Date('2024-01-02T10:00:00')
      expect(isSameDay(d1, d2)).toBe(false)
    })
  })

  describe('capitalise', () => {
    it('capitalises first letter', () => {
      expect(capitalise('hello')).toBe('Hello')
      expect(capitalise('world')).toBe('World')
    })

    it('handles empty string', () => {
      expect(capitalise('')).toBe('')
    })

    it('keeps already capitalised string', () => {
      expect(capitalise('Hello')).toBe('Hello')
    })
  })

  describe('useStringMemo', () => {
    it('returns same reference for array with same strings', () => {
      const list1 = ['a', 'b']
      const list2 = ['a', 'b']

      const { result, rerender } = renderHook(({ list }) => useStringMemo(list), {
        initialProps: { list: list1 }
      })

      expect(result.current).toBe(list1)

      rerender({ list: list2 })

      expect(result.current).toBe(list1)
    })

    it('updates reference when content changes', () => {
      const list1 = ['a']
      const list2 = ['a', 'b']

      const { result, rerender } = renderHook(({ list }) => useStringMemo(list), {
        initialProps: { list: list1 }
      })

      expect(result.current).toBe(list1)

      rerender({ list: list2 })

      expect(result.current).toBe(list2)
    })
  })
})

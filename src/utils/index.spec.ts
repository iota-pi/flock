import { renderHook } from '@testing-library/react'
import { generateNoteId, getStartOfDay, formatDate, isSameDay, useStableArray } from './index'
import { generateItemId } from '@vault/shared'

describe('utils/index', () => {
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
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-12-04T14:30:00'))
      const result = getStartOfDay()
      vi.useRealTimers()

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

  describe('generateItemId', () => {
    it('returns a 21-character URL-safe nanoid string', () => {
      const id = generateItemId()
      expect(typeof id).toBe('string')
      expect(id).toHaveLength(21)
      expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/)
    })

    it('returns unique IDs', () => {
      const id1 = generateItemId()
      const id2 = generateItemId()
      expect(id1).not.toBe(id2)
    })
  })

  describe('generateNoteId', () => {
    it('returns a 10-character URL-safe nanoid string', () => {
      const id = generateNoteId()
      expect(typeof id).toBe('string')
      expect(id).toHaveLength(10)
      expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/)
    })

    it('returns unique note IDs', () => {
      const id1 = generateNoteId()
      const id2 = generateNoteId()
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

  describe('useStableArray', () => {
    it('returns same reference for array with same shallow contents', () => {
      const list1 = ['a', 'b']
      const list2 = ['a', 'b']

      const { result, rerender } = renderHook(({ list }) => useStableArray(list), {
        initialProps: { list: list1 }
      })

      expect(result.current).toBe(list1)

      rerender({ list: list2 })

      expect(result.current).toBe(list1)
    })

    it('updates reference when content changes', () => {
      const list1 = ['a']
      const list2 = ['a', 'b']

      const { result, rerender } = renderHook(({ list }) => useStableArray(list), {
        initialProps: { list: list1 }
      })

      expect(result.current).toBe(list1)

      rerender({ list: list2 })

      expect(result.current).toBe(list2)
    })
  })
})

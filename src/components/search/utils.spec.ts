import { describe, it, expect, vi } from 'vitest'
import {
  isSearchableStandardItem,
  sortSearchables,
  getName,
} from './utils'
import { AnySearchable, SEARCHABLE_BASE_SORT_ORDER } from './types'

// Mock dependencies
vi.mock('../../state/items', () => ({
  compareItems: vi.fn((a, b) => {
    // Simple mock comparison based on id or name-like property if available
    if (a.name && b.name) return a.name.localeCompare(b.name)
    return 0
  }),
  getItemName: vi.fn(item => {
    return item?.name || 'Unknown'
  }),
}))

describe('search/utils.ts', () => {
  describe('isSearchableStandardItem', () => {
    it('should return true for person type', () => {
      const item = { type: 'person', data: {} } as unknown as AnySearchable
      expect(isSearchableStandardItem(item)).toBe(true)
    })

    it('should return true for group type', () => {
      const item = { type: 'group', data: {} } as unknown as AnySearchable
      expect(isSearchableStandardItem(item)).toBe(true)
    })

    it('should return false for other types', () => {
      // Assuming 'create' or other types exist in AnySearchable union
      const item = { type: 'other' } as unknown as AnySearchable // Force to test predicate
      expect(isSearchableStandardItem(item)).toBe(false)
    })
  })

  // SEARCHABLE_BASE_SORT_ORDER is used in sortSearchables.
  // We need to know the order to test it: likely ['person', 'group', ...]
  // Let's assume standard order or rely on the imported constant in the source.
  // Ideally, valid mock data follows the real types.

  describe('sortSearchables', () => {
    it('should sort by type index first', () => {
      // Mock types based on SEARCHABLE_BASE_SORT_ORDER which usually starts with 'person'
      // We can't know the exact order without seeing types.ts, but we know logic uses indexOf.
      // If 'person' is index 0 and 'group' is index 1.
      const a = { type: SEARCHABLE_BASE_SORT_ORDER[0], id: '2' } as AnySearchable
      const b = { type: SEARCHABLE_BASE_SORT_ORDER[1], id: '1' } as AnySearchable

      const result = sortSearchables(a, b)
      expect(result).toBeLessThan(0) // a comes before b
    })

    it('should sort by compareItems if types are same standard items', () => {
      const type = SEARCHABLE_BASE_SORT_ORDER[0]
      // using mocked compareItems which compares 'name'
      const a = { type, id: '1', data: { name: 'Alice' } } as AnySearchable
      const b = { type, id: '2', data: { name: 'Bob' } } as AnySearchable

      expect(sortSearchables(a, b)).toBeLessThan(0) // Alice < Bob
      expect(sortSearchables(b, a)).toBeGreaterThan(0) // Bob > Alice
    })

    it('should sort by id if types are same but not standard items (fallback)', () => {
      // Mock a type that isn't person/group if possible, or force logic

      const itemA = { type: 'custom', id: 'A' } as unknown as AnySearchable
      const itemB = { type: 'custom', id: 'B' } as unknown as AnySearchable

      // Force isSearchableStandardItem to false for these by using unknown type

      expect(sortSearchables(itemA, itemB)).toBeLessThan(0) // A < B
      expect(sortSearchables(itemB, itemA)).toBeGreaterThan(0) // B > A
    })
  })

  describe('getName', () => {
    it('should return item name handling creation option', () => {
      const createOption = { create: true, default: { name: 'New Item' }, type: 'person' } as unknown as AnySearchable
      expect(getName(createOption)).toBe('New Item')
    })

    it('should return item name for standard data', () => {
      const standardOption = { create: false, data: { name: 'Existing Item' }, type: 'person' } as unknown as AnySearchable
      expect(getName(standardOption)).toBe('Existing Item')
    })
  })
})

import {
  isSearchableStandardItem,
  sortSearchables,
  getName,
} from './utils'
import type { AnySearchable } from './types'
import * as itemsModule from '../../state/items'
import { spyOnExports } from '../../utils/testUtils'

// Mock dependencies
beforeEach(() => {
  spyOnExports(itemsModule, {
    compareItems: vi.fn((a, b) => {
      // Simple mock comparison based on id or name-like property if available
      if (a.name && b.name) return a.name.localeCompare(b.name)
      return 0
    }),
    getItemName: vi.fn(item => {
      return item?.name || 'Unknown'
    }),
  })
})

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

    it('should return true for topic type', () => {
      const item = { type: 'topic', data: {} } as unknown as AnySearchable
      expect(isSearchableStandardItem(item)).toBe(true)
    })

    it('should return false for create options', () => {
      const item = { type: 'person', create: true, default: { type: 'person' } } as unknown as AnySearchable
      expect(isSearchableStandardItem(item)).toBe(false)
    })
  })

  describe('sortSearchables', () => {
    it('should sort by type index first', () => {
      const a = { type: 'person', id: '2' } as AnySearchable
      const b = { type: 'group', id: '1' } as AnySearchable

      const result = sortSearchables(a, b)
      expect(result).toBeLessThan(0) // a comes before b
    })

    it('should sort by compareItems if types are same standard items', () => {
      const type = 'person'
      // using mocked compareItems which compares 'name'
      const a = { type, id: '1', data: { name: 'Alice' } } as AnySearchable
      const b = { type, id: '2', data: { name: 'Bob' } } as AnySearchable

      expect(sortSearchables(a, b)).toBeLessThan(0) // Alice < Bob
      expect(sortSearchables(b, a)).toBeGreaterThan(0) // Bob > Alice
    })

    it('should sort by id if types are same but not standard items (fallback)', () => {
      const itemA = { type: 'person', id: 'A', create: true } as unknown as AnySearchable
      const itemB = { type: 'person', id: 'B', create: true } as unknown as AnySearchable

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

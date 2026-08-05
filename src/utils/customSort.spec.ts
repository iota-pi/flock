import { sortItems } from './customSort'
import { getBlankPerson, getBlankGroup, Item } from '../state/items'
import { ItemId } from 'src/shared/schemas/items'

describe('customSort', () => {
  const baseTime = 1000000

  const createPerson = (overrides: Partial<Item> = {}): Item => ({
    ...getBlankPerson(),
    id: 'person-1',
    name: 'Alice',
    created: baseTime,
    ...overrides,
    type: 'person',
  } as unknown as Item)

  const createGroup = (overrides: Partial<Item> = {}): Item => ({
    ...getBlankGroup(),
    id: 'group-1',
    name: 'Group A',
    created: baseTime,
    ...overrides,
    type: 'group',
  } as unknown as Item)

  describe('sortItems', () => {
    it('sorts by name ascending by default (implicit or explicit)', () => {
      const items = [
        createPerson({ id: '2' as ItemId, name: 'Bob' }),
        createPerson({ id: '1' as ItemId, name: 'Alice' }),
        createPerson({ id: '3' as ItemId, name: 'Charlie' }),
      ]

      // Default behavior checks (often name is default if configured properly, but let's be explicit)
      const result = sortItems(items, [{ type: 'name', reverse: false }])
      expect(result.map(i => i.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    })

    it('sorts by name descending', () => {
      const items = [
        createPerson({ id: '2' as ItemId, name: 'Bob' }),
        createPerson({ id: '1' as ItemId, name: 'Alice' }),
        createPerson({ id: '3' as ItemId, name: 'Charlie' }),
      ]
      const result = sortItems(items, [{ type: 'name', reverse: true }])
      expect(result.map(i => i.name)).toEqual(['Charlie', 'Bob', 'Alice'])
    })

    it('sorts by created date (recent first by default for dates, but code says b - a)', () => {
      const items = [
        createPerson({ id: '1' as ItemId, created: 100 }), // Oldest
        createPerson({ id: '2' as ItemId, created: 200 }),
        createPerson({ id: '3' as ItemId, created: 300 }), // Newest
      ]

      const result = sortItems(items, [{ type: 'created', reverse: false }])
      expect(result.map(i => i.created)).toEqual([300, 200, 100])
    })

    it('sorts by created date reverse (oldest first)', () => {
      const items = [
        createPerson({ id: '1' as ItemId, created: 100 }),
        createPerson({ id: '2' as ItemId, created: 200 }),
        createPerson({ id: '3' as ItemId, created: 300 }),
      ]

      const result = sortItems(items, [{ type: 'created', reverse: true }])
      expect(result.map(i => i.created)).toEqual([100, 200, 300])
    })

    it('sorts by lastPrayedFor', () => {
      const items = [
        createPerson({ id: '1' as ItemId, prayedFor: [100] }),
        createPerson({ id: '2' as ItemId, prayedFor: [300] }), // Most recent
        createPerson({ id: '3' as ItemId, prayedFor: [200] }),
        createPerson({ id: '4' as ItemId, prayedFor: [] }), // Never
      ]

      const result = sortItems(items, [{ type: 'lastPrayedFor', reverse: false }])

      expect(result.map(i => i.id)).toEqual(['2', '3', '1', '4'])
    })

    it('sorts by type', () => {
      const items = [
        createGroup({ id: 'g1' as ItemId }),
        createPerson({ id: 'p1' as ItemId }),
        createGroup({ id: 'g2' as ItemId }),
      ]

      const result = sortItems(items, [{ type: 'type', reverse: false }])

      const types = result.map(i => i.type)
      expect(types).toEqual(['person', 'group', 'group'])
    })

    it('sorts by description', () => {
      const items = [
        createPerson({ id: '1' as ItemId, description: 'Zebra' }),
        createPerson({ id: '2' as ItemId, description: 'Apple' }),
      ]
      const result = sortItems(items, [{ type: 'description', reverse: false }])
      expect(result.map(i => i.description)).toEqual(['Apple', 'Zebra'])
    })

    it('sorts by archived (archived last by default)', () => {
      const items = [
        createPerson({ id: '1' as ItemId, archived: true }),
        createPerson({ id: '2' as ItemId, archived: false }),
        createPerson({ id: '3' as ItemId, archived: true }),
      ]

      const result = sortItems(items, [{ type: 'archived', reverse: false }])
      expect(result.map(i => i.archived)).toEqual([false, true, true])
    })

    it('falls back to compareIds when primary sort is equal', () => {
      const items = [
        createPerson({ id: 'B' as ItemId, name: 'SameName' }),
        createPerson({ id: 'A' as ItemId, name: 'SameName' }),
      ]

      const result = sortItems(items, [{ type: 'name', reverse: false }])
      expect(result.map(i => i.id)).toEqual(['A', 'B'])
    })

    it('respects multiple criteria', () => {
      const items = [
        createPerson({ id: '1' as ItemId, name: 'Alice', description: 'B' }),
        createPerson({ id: '2' as ItemId, name: 'Alice', description: 'A' }),
        createPerson({ id: '3' as ItemId, name: 'Bob', description: 'C' }),
      ]

      const result = sortItems(items, [
        { type: 'name', reverse: false },
        { type: 'description', reverse: false }
      ])

      expect(result.map(i => i.id)).toEqual(['2', '1', '3'])
    })
  })
})

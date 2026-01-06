import { sortItems } from './customSort'
import { getBlankPerson, getBlankGroup, Item } from '../state/items'

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
        createPerson({ id: '2', name: 'Bob' }),
        createPerson({ id: '1', name: 'Alice' }),
        createPerson({ id: '3', name: 'Charlie' }),
      ]

      // Default behavior checks (often name is default if configured properly, but let's be explicit)
      const result = sortItems(items, [{ type: 'name', reverse: false }])
      expect(result.map(i => i.name)).toEqual(['Alice', 'Bob', 'Charlie'])
    })

    it('sorts by name descending', () => {
      const items = [
        createPerson({ id: '2', name: 'Bob' }),
        createPerson({ id: '1', name: 'Alice' }),
        createPerson({ id: '3', name: 'Charlie' }),
      ]
      const result = sortItems(items, [{ type: 'name', reverse: true }])
      expect(result.map(i => i.name)).toEqual(['Charlie', 'Bob', 'Alice'])
    })

    it('sorts by created date (recent first by default for dates, but code says b - a)', () => {
      const items = [
        createPerson({ id: '1', created: 100 }), // Oldest
        createPerson({ id: '2', created: 200 }),
        createPerson({ id: '3', created: 300 }), // Newest
      ]

      const result = sortItems(items, [{ type: 'created', reverse: false }])
      expect(result.map(i => i.created)).toEqual([300, 200, 100])
    })

    it('sorts by created date reverse (oldest first)', () => {
      const items = [
        createPerson({ id: '1', created: 100 }),
        createPerson({ id: '2', created: 200 }),
        createPerson({ id: '3', created: 300 }),
      ]

      const result = sortItems(items, [{ type: 'created', reverse: true }])
      expect(result.map(i => i.created)).toEqual([100, 200, 300])
    })

    it('sorts by lastPrayedFor', () => {
      const items = [
        createPerson({ id: '1', prayedFor: [100] }),
        createPerson({ id: '2', prayedFor: [300] }), // Most recent
        createPerson({ id: '3', prayedFor: [200] }),
        createPerson({ id: '4', prayedFor: [] }), // Never
      ]

      const result = sortItems(items, [{ type: 'lastPrayedFor', reverse: false }])

      expect(result.map(i => i.id)).toEqual(['2', '3', '1', '4'])
    })

    it('sorts by type', () => {
      const items = [
        createGroup({ id: 'g1' }),
        createPerson({ id: 'p1' }),
        createGroup({ id: 'g2' }),
      ]

      const result = sortItems(items, [{ type: 'type', reverse: false }])

      const types = result.map(i => i.type)
      expect(types).toEqual(['person', 'group', 'group'])
    })

    it('sorts by description', () => {
      const items = [
        createPerson({ id: '1', description: 'Zebra' }),
        createPerson({ id: '2', description: 'Apple' }),
      ]
      const result = sortItems(items, [{ type: 'description', reverse: false }])
      expect(result.map(i => i.description)).toEqual(['Apple', 'Zebra'])
    })

    it('sorts by archived (archived last by default)', () => {
      const items = [
        createPerson({ id: '1', archived: true }),
        createPerson({ id: '2', archived: false }),
        createPerson({ id: '3', archived: true }),
      ]

      const result = sortItems(items, [{ type: 'archived', reverse: false }])
      expect(result.map(i => i.archived)).toEqual([false, true, true])
    })

    it('falls back to compareIds when primary sort is equal', () => {
      const items = [
        createPerson({ id: 'B', name: 'SameName' }),
        createPerson({ id: 'A', name: 'SameName' }),
      ]

      const result = sortItems(items, [{ type: 'name', reverse: false }])
      expect(result.map(i => i.id)).toEqual(['A', 'B'])
    })

    it('respects multiple criteria', () => {
      const items = [
        createPerson({ id: '1', name: 'Alice', description: 'B' }),
        createPerson({ id: '2', name: 'Alice', description: 'A' }),
        createPerson({ id: '3', name: 'Bob', description: 'C' }),
      ]

      const result = sortItems(items, [
        { type: 'name', reverse: false },
        { type: 'description', reverse: false }
      ])

      expect(result.map(i => i.id)).toEqual(['2', '1', '3'])
    })
  })
})

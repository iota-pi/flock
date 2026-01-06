import { filterItems, FilterCriterion, getBaseValue } from './customFilter'
import { getBlankPerson } from '../state/items'
import { Frequency } from './frequencies'


describe('customFilter', () => {
  const baseDate = new Date('2024-01-01T12:00:00Z').getTime()

  const createItem = (overrides: Partial<ReturnType<typeof getBlankPerson>> = {}) => ({
    ...getBlankPerson(),
    created: baseDate,
    ...overrides,
  })

  describe('filterItems', () => {
    it('returns all items if no criteria provided', () => {
      const items = [createItem(), createItem()]
      expect(filterItems(items, [])).toHaveLength(2)
      expect(filterItems(items, [])).toBe(items) // Should return original array reference
    })

    describe('name filter', () => {
      const items = [
        createItem({ name: 'Alice' }),
        createItem({ name: 'Bob' }),
        createItem({ name: 'Charlie' }),
      ]

      it('filters by name contains (case insensitive)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'name',
          baseOperator: 'contains',
          inverse: false,
          operator: 'contains',
          value: 'li',
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(2) // Alice and Charlie
        expect(result.map(i => i.name)).toEqual(['Alice', 'Charlie'])
      })

      it('filters by name is (exact match)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'name',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: 'Bob',
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('Bob')
      })

      it('handles inverse filtering', () => {
        const criteria: FilterCriterion[] = [{
          type: 'name',
          baseOperator: 'contains',
          inverse: true,
          operator: 'notcontains',
          value: 'li',
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].name).toBe('Bob')
      })
    })

    describe('description filter', () => {
      const items = [
        createItem({ description: 'A friend from work' }),
        createItem({ description: 'Family member' }),
      ]

      it('filters by description contains', () => {
        const criteria: FilterCriterion[] = [{
          type: 'description',
          baseOperator: 'contains',
          inverse: false,
          operator: 'contains',
          value: 'work',
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].description).toBe('A friend from work')
      })
    })

    describe('created date filter', () => {
      const d1 = new Date('2024-01-01T12:00:00Z').getTime()
      const d2 = new Date('2024-01-02T12:00:00Z').getTime()
      const d3 = new Date('2024-01-03T12:00:00Z').getTime()

      const items = [
        createItem({ created: d1 }),
        createItem({ created: d2 }),
        createItem({ created: d3 }),
      ]

      it('filters by created date is (same day)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'created',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: d2,
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].created).toBe(d2)
      })

      it('filters by created date greater (after)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'created',
          baseOperator: 'greater',
          inverse: false,
          operator: 'after',
          value: d2,
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].created).toBe(d3)
      })

      it('filters by created date before (inverse greater)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'created',
          baseOperator: 'greater',
          inverse: true,
          operator: 'before',
          value: d2,
        }]

        const result = filterItems(items, criteria)
        expect(result).toHaveLength(2)
        expect(result.map(i => i.created)).toEqual([d1, d2])
      })
    })

    describe('prayerFrequency filter', () => {
      const items = [
        createItem({ prayerFrequency: 'daily' }),
        createItem({ prayerFrequency: 'weekly' }),
        createItem({ prayerFrequency: 'monthly' }),
      ]

      it('filters by exact frequency', () => {
        const criteria: FilterCriterion[] = [{
          type: 'prayerFrequency',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: 'weekly' as Frequency,
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].prayerFrequency).toBe('weekly')
      })

      it('filters by frequency greater (more frequent than)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'prayerFrequency',
          baseOperator: 'greater',
          inverse: false,
          operator: 'greater',
          value: 'weekly' as Frequency,
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].prayerFrequency).toBe('daily')
      })

      it('filters by frequency less than (less frequent than)', () => {
        const criteria: FilterCriterion[] = [{
          type: 'prayerFrequency',
          baseOperator: 'greater',
          inverse: true,
          operator: 'lessthan',
          value: 'weekly' as Frequency,
        }]
        const result = filterItems(items, criteria)
        expect(result).toHaveLength(2)
        expect(result.map(i => i.prayerFrequency)).toEqual(expect.arrayContaining(['weekly', 'monthly']))
      })
    })

    describe('multiple criteria', () => {
      it('combines multiple criteria with AND logic', () => {
        const items = [
          createItem({ name: 'Alice', description: 'friend' }),
          createItem({ name: 'Alice', description: 'coworker' }),
          createItem({ name: 'Bob', description: 'friend' }),
        ]

        const criteria: FilterCriterion[] = [
          {
            type: 'name',
            baseOperator: 'is',
            inverse: false,
            operator: 'is',
            value: 'Alice',
          },
          {
            type: 'description',
            baseOperator: 'contains',
            inverse: false,
            operator: 'contains',
            value: 'friend',
          }
        ]

        const result = filterItems(items, criteria)
        expect(result).toHaveLength(1)
        expect(result[0].description).toBe('friend')
      })
    })
  })

  describe('getBaseValue', () => {
    it('returns correct default values for types', () => {
      expect(getBaseValue('name')).toBe('')
      expect(getBaseValue('created')).toEqual(expect.any(Number))
      expect(getBaseValue('prayerFrequency')).toBe('monthly')
    })
  })
})

import { describe, it, expect } from 'vitest'
import { runAllMigrationsInMemory } from './utils'
import { Item, getBlankPerson } from '../items'

describe('runAllMigrationsInMemory', () => {
  it('should migrate items correctly', async () => {
    const legacyItem: Item = {
      ...getBlankPerson(),
      name: 'Legacy item',
      summary: 'Legacy summary',
      notes: [],
    }

    const migrated = await runAllMigrationsInMemory([legacyItem])

    expect(migrated.length).toBe(1)
    const item = migrated[0]
    expect(item.summary).toBe('')
    expect(item.notes.length).toBe(1)
    expect(item.notes[0].text).toBe('Legacy summary')
  })

  it('should handle items that need no migration', async () => {
    const modernItem: Item = {
      ...getBlankPerson(),
      name: 'Modern item',
      notes: [{ id: '1', text: 'Note', archived: false, created: 0 }],
    }

    const migrated = await runAllMigrationsInMemory([modernItem])

    expect(migrated.length).toBe(1)
    expect(migrated[0]).toEqual(modernItem)
  })
})

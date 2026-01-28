import { describe, it, expect } from 'vitest'
import { migrations } from './migrations'
import { Item, getBlankPerson } from '../items'

describe('migrations', () => {
  describe('migrate-summary-to-notes', () => {
    const migration = migrations.find(m => m.id === 'migrate-summary-to-notes')

    it('should be defined', () => {
      expect(migration).toBeDefined()
    })

    it('should migrate summary to notes', async () => {
      const item: Item = {
        ...getBlankPerson(),
        summary: 'Legacy summary',
        notes: [],
      }

      const result = await migration!.migrate({ items: [item] })

      expect(result.length).toBe(1)
      const migratedItem = result[0]
      expect(migratedItem.summary).toBe('')
      expect(migratedItem.notes.length).toBe(1)
      expect(migratedItem.notes[0].text).toBe('Legacy summary')
    })

    it('should not migrate if notes already exist', async () => {
      const item: Item = {
        ...getBlankPerson(),
        summary: 'Legacy summary',
        notes: [{ id: '1', text: 'Existing note', archived: false, created: 0 }],
      }

      const result = await migration!.migrate({ items: [item] })
      expect(result.length).toBe(0) // No items updated
    })
  })
})

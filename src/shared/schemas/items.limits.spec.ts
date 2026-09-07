import { describe, it, expect } from 'vitest'
import { ITEM_LIMITS } from '../constants/limits'
import { personItemSchema, ItemId } from './items'

describe('ITEM_LIMITS', () => {
  it('defines the correct limits and 80% warning thresholds', () => {
    expect(ITEM_LIMITS.NAME_MAX).toBe(500)
    expect(ITEM_LIMITS.NAME_WARN).toBe(400)
    expect(ITEM_LIMITS.NAME_WARN).toBe(Math.floor(ITEM_LIMITS.NAME_MAX * 0.8))

    expect(ITEM_LIMITS.DESCRIPTION_MAX).toBe(1000)
    expect(ITEM_LIMITS.DESCRIPTION_WARN).toBe(800)
    expect(ITEM_LIMITS.DESCRIPTION_WARN).toBe(Math.floor(ITEM_LIMITS.DESCRIPTION_MAX * 0.8))

    expect(ITEM_LIMITS.NOTE_MAX).toBe(5000)
    expect(ITEM_LIMITS.NOTE_WARN).toBe(4000)
    expect(ITEM_LIMITS.NOTE_WARN).toBe(Math.floor(ITEM_LIMITS.NOTE_MAX * 0.8))
  })
})

describe('Item Zod Schema limits', () => {
  const baseValidItem = {
    id: 'item-123' as ItemId,
    type: 'person' as const,
    name: 'A'.repeat(500),
    description: 'B'.repeat(1000),
    archived: false,
    created: 123456789,
    prayerFrequency: 'weekly' as const,
    prayedFor: [],
    notes: [
      {
        id: 'note-1',
        text: 'C'.repeat(5000),
        archived: false,
        time: 123456789,
      },
    ],
  }

  it('accepts items and notes within maximum limits', () => {
    const result = personItemSchema.safeParse(baseValidItem)
    expect(result.success).toBe(true)
  })

  it('rejects names exceeding 500 characters', () => {
    const oversized = {
      ...baseValidItem,
      name: 'A'.repeat(501),
    }
    const result = personItemSchema.safeParse(oversized)
    expect(result.success).toBe(false)
  })

  it('rejects descriptions exceeding 1000 characters', () => {
    const oversized = {
      ...baseValidItem,
      description: 'B'.repeat(1001),
    }
    const result = personItemSchema.safeParse(oversized)
    expect(result.success).toBe(false)
  })

  it('filters out notes exceeding 5000 characters via catch fallback', () => {
    const oversizedNote = {
      ...baseValidItem,
      notes: [
        {
          id: 'note-1',
          text: 'C'.repeat(5001),
          archived: false,
          time: 123456789,
        },
      ],
    }
    const parsed = personItemSchema.parse(oversizedNote)
    // Notes schema uses .catch([]) for invalid notes array
    expect(parsed.notes).toEqual([])
  })
})

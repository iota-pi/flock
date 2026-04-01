import { describe, expect, it } from 'vitest'
import { diffItems } from './diff'
import type { Item } from '../state/items'

function createItem(overrides: Partial<Item> = {}): Item {
  const now = Date.now()
  return {
    id: 'item-1',
    type: 'person',
    name: 'Alex',
    description: 'desc',
    prayerFrequency: 'monthly',
    created: now,
    archived: false,
    notes: [],
    prayedFor: [],
    ...overrides,
  } as Item
}

describe('diffItems', () => {
  it('ignores primitive array order', () => {
    const existing = createItem({
      prayedFor: [10, 20],
    })
    const incoming = createItem({
      prayedFor: [20, 10],
    })

    expect(diffItems(existing, incoming)).toEqual([])
  })

  it('detects nested object changes', () => {
    const existing = createItem({
      notes: [{ id: 'n1', text: 'hello', archived: false, time: 10 }],
    })
    const incoming = createItem({
      notes: [{ id: 'n1', text: 'updated', archived: false, time: 10 }],
    })

    expect(diffItems(existing, incoming)).toEqual(['notes'])
  })

  it('ignores id and version metadata keys', () => {
    const existing = createItem() as Item & { version?: number }
    existing.version = 1

    const incoming = createItem({ id: 'item-2' }) as Item & { version?: number }
    incoming.version = 2

    expect(diffItems(existing, incoming)).toEqual([])
  })
})

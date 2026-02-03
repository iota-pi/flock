import { describe, it, expect } from 'vitest'
import { threeWayMerge } from './merge'

interface TestItem {
  id: string
  text: string
  nested?: { value: number }
}

describe('threeWayMerge nested object merging', () => {
  it('should handle nested object changes in arrays by ID', () => {
    const base: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Base' }]
    }
    const theirs: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Theirs' }]
    }
    const yours: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Yours' }] // Conflict!
    }

    const result = threeWayMerge(base, theirs, yours)

    // Current behavior (hash-based) sees 3 distinct items or 1 removed + 2 added
    // Ideally: 1 item, conflict resolved (local wins -> "Yours")

    expect(result.items.length).toBe(1)
    expect(result.items[0].text).toBe('Yours')
    expect(result.items[0].id).toBe('1')
  })

  it('should recursively merge item properties if no conflict', () => {
    const base: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Base', nested: { value: 1 } }]
    }
    const theirs: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Base', nested: { value: 2 } }] // Remote changed nested
    }
    const yours: { items: TestItem[] } = {
      items: [{ id: '1', text: 'Changed', nested: { value: 1 } }] // Local changed text
    }

    const result = threeWayMerge(base, theirs, yours)

    // Ideal result: text='Changed', nested.value=2 (merged)
    // Hash-based result: probably conflict or dupes

    expect(result.items.length).toBe(1)
    expect(result.items[0].id).toBe('1')
    expect(result.items[0].text).toBe('Changed')
    expect(result.items[0].nested?.value).toBe(2)
  })
})

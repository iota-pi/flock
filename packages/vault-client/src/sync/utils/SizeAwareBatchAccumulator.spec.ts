import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_COUNT,
  DEFAULT_MAX_BATCH_BYTES,
} from './SizeAwareBatchAccumulator'

interface TestItem {
  id: string
  payload: string
}

describe('SizeAwareBatchAccumulator', () => {
  it('initializes with default options', () => {
    const accumulator = new SizeAwareBatchAccumulator<TestItem>()
    expect(accumulator.maxBatchCount).toBe(DEFAULT_MAX_BATCH_COUNT)
    expect(accumulator.maxBatchBytes).toBe(DEFAULT_MAX_BATCH_BYTES)
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.items).toEqual([])
  })

  it('accumulates items', () => {
    const accumulator = new SizeAwareBatchAccumulator<TestItem>({ maxBatchCount: 5, maxBatchBytes: 1000 })

    const item1: TestItem = { id: '1', payload: 'hello' }
    expect(accumulator.wouldExceed(5)).toBe(false)
    accumulator.push(item1, 5)

    expect(accumulator.isEmpty).toBe(false)
    expect(accumulator.size).toBe(1)
    expect(accumulator.items).toEqual([item1])

    const item2: TestItem = { id: '2', payload: ' world' }
    accumulator.push(item2, 6)

    expect(accumulator.size).toBe(2)
    expect(accumulator.items).toEqual([item1, item2])
  })

  it('indicates wouldExceed when item count reaches maxBatchCount', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({ maxBatchCount: 2, maxBatchBytes: 1000 })

    accumulator.push(1, 10)
    expect(accumulator.wouldExceed(10)).toBe(false)

    accumulator.push(2, 10)
    // Count is now 2 (maxBatchCount), so next item would exceed
    expect(accumulator.wouldExceed(10)).toBe(true)
  })

  it('indicates wouldExceed when byte size reaches maxBatchBytes', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({ maxBatchCount: 10, maxBatchBytes: 100 })

    accumulator.push(1, 80)
    expect(accumulator.wouldExceed(15)).toBe(false)
    expect(accumulator.wouldExceed(25)).toBe(true)
  })

  it('drains items and resets state', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({ maxBatchCount: 5, maxBatchBytes: 100 })

    accumulator.push(1, 20)
    accumulator.push(2, 30)
    expect(accumulator.size).toBe(2)

    const drained = accumulator.drain()
    expect(drained).toEqual([1, 2])
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.wouldExceed(100)).toBe(false)
  })

  it('clears items and resets state', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({ maxBatchCount: 5, maxBatchBytes: 100 })

    accumulator.push(1, 20)
    accumulator.clear()
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.wouldExceed(100)).toBe(false)
  })

  describe('static batch', () => {
    const payloadLength = (item: TestItem) => item.payload.length

    it('returns empty array when given empty input', () => {
      expect(SizeAwareBatchAccumulator.batch<TestItem>([], { calculateSize: payloadLength })).toEqual([])
    })

    it('partitions items by maxBatchCount', () => {
      const batches = SizeAwareBatchAccumulator.batch([1, 2, 3, 4, 5], {
        maxBatchCount: 2,
        maxBatchBytes: 10000,
        calculateSize: n => n,
      })

      expect(batches).toEqual([[1, 2], [3, 4], [5]])
    })

    it('partitions items by maxBatchBytes', () => {
      const items: TestItem[] = [
        { id: '1', payload: 'a'.repeat(100) },
        { id: '2', payload: 'b'.repeat(150) },
        { id: '3', payload: 'c'.repeat(120) },
        { id: '4', payload: 'd'.repeat(80) },
      ]

      const batches = SizeAwareBatchAccumulator.batch(items, {
        maxBatchCount: 10,
        maxBatchBytes: 260,
        calculateSize: payloadLength,
      })

      // batch 1: item 1 (100) + item 2 (150) = 250 <= 260
      // batch 2: item 3 (120) + item 4 (80) = 200 <= 260
      expect(batches).toHaveLength(2)
      expect(batches[0].map(i => i.id)).toEqual(['1', '2'])
      expect(batches[1].map(i => i.id)).toEqual(['3', '4'])
    })

    it('isolates oversized item in its own single-item batch', () => {
      const items: TestItem[] = [
        { id: 'normal-1', payload: 'a'.repeat(50) },
        { id: 'oversized', payload: 'b'.repeat(500) }, // exceeds 200 limit
        { id: 'normal-2', payload: 'c'.repeat(50) },
      ]

      const batches = SizeAwareBatchAccumulator.batch(items, {
        maxBatchCount: 10,
        maxBatchBytes: 200,
        calculateSize: payloadLength,
      })

      expect(batches).toHaveLength(3)
      expect(batches[0].map(i => i.id)).toEqual(['normal-1'])
      expect(batches[1].map(i => i.id)).toEqual(['oversized'])
      expect(batches[2].map(i => i.id)).toEqual(['normal-2'])
    })
  })
})

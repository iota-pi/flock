import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_COUNT,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_PAYLOAD_LIMIT,
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
    expect(accumulator.bytes).toBe(0)
    expect(accumulator.items).toEqual([])
  })

  it('accepts calculateSize directly as constructor argument', () => {
    const calc = (item: TestItem) => item.payload.length
    const accumulator = new SizeAwareBatchAccumulator<TestItem>(calc)
    expect(accumulator.calculateSize).toBe(calc)
    expect(accumulator.maxBatchCount).toBe(DEFAULT_MAX_BATCH_COUNT)
    expect(accumulator.maxBatchBytes).toBe(DEFAULT_MAX_BATCH_BYTES)
  })

  it('caps maxBatchBytes at maxPayloadLimit', () => {
    const accumulator = new SizeAwareBatchAccumulator({
      maxBatchBytes: 10 * 1024 * 1024,
      maxPayloadLimit: DEFAULT_MAX_PAYLOAD_LIMIT,
    })
    expect(accumulator.maxBatchBytes).toBe(DEFAULT_MAX_PAYLOAD_LIMIT)
  })

  it('accumulates items and tracks byte sizes using calculateSize', () => {
    const accumulator = new SizeAwareBatchAccumulator<TestItem>({
      maxBatchCount: 5,
      maxBatchBytes: 1000,
      calculateSize: item => item.payload.length,
    })

    const item1: TestItem = { id: '1', payload: 'hello' } // 5 bytes
    expect(accumulator.wouldExceed(item1)).toBe(false)
    accumulator.push(item1)

    expect(accumulator.isEmpty).toBe(false)
    expect(accumulator.size).toBe(1)
    expect(accumulator.bytes).toBe(5)
    expect(accumulator.items).toEqual([item1])

    const item2: TestItem = { id: '2', payload: ' world' } // 6 bytes
    accumulator.push(item2)

    expect(accumulator.size).toBe(2)
    expect(accumulator.bytes).toBe(11)
    expect(accumulator.items).toEqual([item1, item2])
  })

  it('supports explicit size override in wouldExceed and push', () => {
    const accumulator = new SizeAwareBatchAccumulator<TestItem>({
      maxBatchCount: 5,
      maxBatchBytes: 50,
      calculateSize: item => item.payload.length,
    })

    const item1: TestItem = { id: '1', payload: 'short' } // 5 bytes by calculation
    // Override explicit size with 30 bytes
    expect(accumulator.wouldExceed(item1, 30)).toBe(false)
    accumulator.push(item1, 30)
    expect(accumulator.bytes).toBe(30)

    // Another 25 bytes would exceed 50 limit
    expect(accumulator.wouldExceed(item1, 25)).toBe(true)
    // But 10 bytes would not exceed
    expect(accumulator.wouldExceed(item1, 10)).toBe(false)
  })

  it('supports number items natively without calculateSize', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({
      maxBatchCount: 3,
      maxBatchBytes: 100,
    })

    expect(accumulator.wouldExceed(40)).toBe(false)
    accumulator.push(40)
    expect(accumulator.bytes).toBe(40)

    expect(accumulator.wouldExceed(50)).toBe(false)
    accumulator.push(50)
    expect(accumulator.bytes).toBe(90)

    expect(accumulator.wouldExceed(20)).toBe(true)
  })

  it('throws an error if no calculateSize is provided and non-number item is checked without explicit size', () => {
    const accumulator = new SizeAwareBatchAccumulator<TestItem>()
    const item: TestItem = { id: '1', payload: 'test' }

    expect(() => accumulator.wouldExceed(item)).toThrow(
      'SizeAwareBatchAccumulator: No calculateSize function provided and item is not a number',
    )
    expect(() => accumulator.push(item)).toThrow(
      'SizeAwareBatchAccumulator: No calculateSize function provided and item is not a number',
    )
  })

  it('indicates wouldExceed when item count reaches maxBatchCount', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({
      maxBatchCount: 2,
      maxBatchBytes: 1000,
    })

    accumulator.push(10)
    expect(accumulator.wouldExceed(10)).toBe(false)

    accumulator.push(10)
    // Count is now 2 (maxBatchCount), so next item would exceed
    expect(accumulator.wouldExceed(10)).toBe(true)
  })

  it('indicates wouldExceed when byte size reaches maxBatchBytes', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({
      maxBatchCount: 10,
      maxBatchBytes: 100,
    })

    accumulator.push(80)
    expect(accumulator.wouldExceed(15)).toBe(false)
    expect(accumulator.wouldExceed(25)).toBe(true)
  })

  it('drains items and resets state', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({
      maxBatchCount: 5,
      maxBatchBytes: 100,
    })

    accumulator.push(20)
    accumulator.push(30)
    expect(accumulator.size).toBe(2)
    expect(accumulator.bytes).toBe(50)

    const drained = accumulator.drain()
    expect(drained).toEqual([20, 30])
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.bytes).toBe(0)
  })

  it('clears items and resets state', () => {
    const accumulator = new SizeAwareBatchAccumulator<number>({
      maxBatchCount: 5,
      maxBatchBytes: 100,
    })

    accumulator.push(20)
    accumulator.clear()
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.bytes).toBe(0)
  })

  describe('accumulateAll and static batch', () => {
    it('returns empty array when given empty input', () => {
      const accumulator = new SizeAwareBatchAccumulator<number>()
      expect(accumulator.accumulateAll([])).toEqual([])
      expect(SizeAwareBatchAccumulator.batch([])).toEqual([])
    })

    it('partitions items by maxBatchCount', () => {
      const items = [1, 2, 3, 4, 5]
      const batches = SizeAwareBatchAccumulator.batch(items, {
        maxBatchCount: 2,
        maxBatchBytes: 10000,
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
        calculateSize: item => item.payload.length,
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
        calculateSize: item => item.payload.length,
      })

      expect(batches).toHaveLength(3)
      expect(batches[0].map(i => i.id)).toEqual(['normal-1'])
      expect(batches[1].map(i => i.id)).toEqual(['oversized'])
      expect(batches[2].map(i => i.id)).toEqual(['normal-2'])
    })
  })
})

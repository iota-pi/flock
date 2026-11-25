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
})

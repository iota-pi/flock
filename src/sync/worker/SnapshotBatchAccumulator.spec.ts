import { describe, it, expect, beforeEach } from 'vitest'
import {
  SnapshotBatchAccumulator,
  estimateSnapshotSize,
  type PreparedSnapshotItem,
} from './SnapshotBatchAccumulator'
import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { ItemId } from 'src/shared/schemas/items'

function createMockSnapshot(itemId: string, cipherLength: number): VaultSnapshotInput {
  return {
    itemId: itemId as ItemId,
    snapshot: {
      iv: 'iv-12345678',
      cipher: 'a'.repeat(cipherLength),
      kver: '1',
    },
    snapshotCursor: 1,
    type: 'note',
    modified: 1000,
  }
}

describe('estimateSnapshotSize', () => {
  it('estimates snapshot size based on cipher, iv, itemId, and overhead without JSON.stringify', () => {
    const snapshot = createMockSnapshot('item-1', 100)
    const estimated = estimateSnapshotSize(snapshot)
    // 100 (cipher) + 11 (iv) + 6 (itemId) + 128 (base overhead) = 245
    expect(estimated).toBe(245)
  })

  it('handles empty or missing optional fields safely', () => {
    const snapshot: VaultSnapshotInput = {
      itemId: '' as ItemId,
      snapshot: {
        iv: '',
        cipher: '',
      },
      snapshotCursor: 0,
      type: 'note',
      modified: 0,
    }
    const estimated = estimateSnapshotSize(snapshot)
    expect(estimated).toBe(128)
  })
})

describe('SnapshotBatchAccumulator', () => {
  let accumulator: SnapshotBatchAccumulator

  beforeEach(() => {
    accumulator = new SnapshotBatchAccumulator({
      maxBatchCount: 3,
      maxBatchBytes: 500,
    })
  })

  it('starts empty', () => {
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.bytes).toBe(0)
    expect(accumulator.items).toEqual([])
  })

  it('accumulates items correctly', () => {
    const item1: PreparedSnapshotItem = {
      snapshot: createMockSnapshot('item-1', 50),
      tick: 1,
    }
    const size1 = estimateSnapshotSize(item1.snapshot)

    expect(accumulator.wouldExceed(size1)).toBe(false)
    accumulator.push(item1, size1)

    expect(accumulator.isEmpty).toBe(false)
    expect(accumulator.size).toBe(1)
    expect(accumulator.bytes).toBe(size1)
    expect(accumulator.items).toEqual([item1])
  })

  it('indicates wouldExceed when count reaches maxBatchCount', () => {
    for (let i = 1; i <= 3; i++) {
      const item: PreparedSnapshotItem = {
        snapshot: createMockSnapshot(`item-${i}`, 10),
        tick: i,
      }
      accumulator.push(item, 50)
    }

    expect(accumulator.size).toBe(3)
    // Already at maxBatchCount (3), so next item would exceed
    expect(accumulator.wouldExceed(50)).toBe(true)
  })

  it('indicates wouldExceed when byte limit is reached', () => {
    const item1: PreparedSnapshotItem = {
      snapshot: createMockSnapshot('item-1', 200),
      tick: 1,
    }
    accumulator.push(item1, 400)

    // Current is 400 bytes, max is 500. Adding 150 bytes would exceed 500.
    expect(accumulator.wouldExceed(150)).toBe(true)
    expect(accumulator.wouldExceed(50)).toBe(false)
  })

  it('drains accumulated items and resets byte count', () => {
    const item1: PreparedSnapshotItem = {
      snapshot: createMockSnapshot('item-1', 10),
      tick: 1,
    }
    accumulator.push(item1, 100)

    const drained = accumulator.drain()
    expect(drained).toEqual([item1])
    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.bytes).toBe(0)
  })

  it('clears accumulated items without returning', () => {
    const item1: PreparedSnapshotItem = {
      snapshot: createMockSnapshot('item-1', 10),
      tick: 1,
    }
    accumulator.push(item1, 100)
    accumulator.clear()

    expect(accumulator.isEmpty).toBe(true)
    expect(accumulator.size).toBe(0)
    expect(accumulator.bytes).toBe(0)
  })

  it('caps maxBatchBytes at 2MB limit', () => {
    const largeAccumulator = new SnapshotBatchAccumulator({
      maxBatchBytes: 10 * 1024 * 1024, // 10MB requested
    })
    expect(largeAccumulator.maxBatchBytes).toBe(2 * 1024 * 1024)
  })
})

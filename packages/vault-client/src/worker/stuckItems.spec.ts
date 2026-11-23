import type { ItemId } from '@vault/shared'
import type { PendingMark } from './ChangeOutbox'
import { areStuckItemsEqual, countStuckItems } from './stuckItems'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const NOW = 10 * SYNC_TIMEOUTS.stuckPendingAge
const OLD = NOW - SYNC_TIMEOUTS.stuckPendingAge
const RECENT = OLD + 1

function mark(itemId: string, createdAt: number, blocked?: PendingMark['blocked']): PendingMark {
  return { itemId: itemId as ItemId, tick: 1, createdAt, ...(blocked ? { blocked } : {}) }
}

describe('countStuckItems', () => {
  it('counts only marks that have waited the full age', () => {
    expect(countStuckItems([mark('a', OLD), mark('b', RECENT)], NOW)).toEqual({ unknown: 1 })
  })

  it('reports none when nothing has waited that long', () => {
    expect(countStuckItems([mark('a', RECENT), mark('b', RECENT)], NOW)).toBeUndefined()
  })

  it('counts each by what the push recorded', () => {
    const counts = countStuckItems(
      [mark('a', OLD, 'unloadable'), mark('b', OLD), mark('c', OLD, 'snapshotOnly'), mark('d', OLD, 'unloadable')],
      NOW,
    )

    expect(counts).toEqual({ unknown: 1, snapshotOnly: 1, unloadable: 2 })
  })
})

describe('areStuckItemsEqual', () => {
  it('compares counts by reason, treating none as absent', () => {
    expect(areStuckItemsEqual(undefined, undefined)).toBe(true)
    expect(areStuckItemsEqual({ unknown: 1 }, { unknown: 1 })).toBe(true)
    expect(areStuckItemsEqual({ unknown: 1 }, { unknown: 2 })).toBe(false)
    expect(areStuckItemsEqual({ unknown: 1 }, undefined)).toBe(false)
    expect(areStuckItemsEqual({ unknown: 1 }, { unknown: 1, unloadable: 1 })).toBe(false)
  })
})

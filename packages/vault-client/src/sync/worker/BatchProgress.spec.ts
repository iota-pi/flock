import type { ItemId } from '@vault/shared'
import { BatchProgress } from './BatchProgress'

const ITEM = 'item-1' as ItemId
const OTHER = 'item-2' as ItemId

describe('BatchProgress', () => {
  let progress: BatchProgress

  beforeEach(() => {
    progress = new BatchProgress()
  })

  it('is 0 for a batch with no recorded progress', () => {
    expect(progress.get(ITEM, 10)).toBe(0)
  })

  it('records progress per item and cursor', () => {
    progress.set(ITEM, 10, 2)
    progress.set(ITEM, 20, 1)
    progress.set(OTHER, 10, 3)

    expect(progress.get(ITEM, 10)).toBe(2)
    expect(progress.get(ITEM, 20)).toBe(1)
    expect(progress.get(OTHER, 10)).toBe(3)
  })

  it('clears a single batch', () => {
    progress.set(ITEM, 10, 2)
    progress.set(ITEM, 20, 1)
    progress.clear(ITEM, 10)

    expect(progress.get(ITEM, 10)).toBe(0)
    expect(progress.get(ITEM, 20)).toBe(1)
  })

  it('clears every batch at or below a cursor', () => {
    progress.set(ITEM, 10, 2)
    progress.set(ITEM, 20, 1)
    progress.set(ITEM, 30, 4)
    progress.clearUpTo(ITEM, 20)

    expect(progress.get(ITEM, 10)).toBe(0)
    expect(progress.get(ITEM, 20)).toBe(0)
    expect(progress.get(ITEM, 30)).toBe(4)
  })

  it('clears one item or all of them', () => {
    progress.set(ITEM, 10, 2)
    progress.set(OTHER, 10, 3)
    progress.clearItem(ITEM)

    expect(progress.get(ITEM, 10)).toBe(0)
    expect(progress.get(OTHER, 10)).toBe(3)

    progress.clearAll()
    expect(progress.get(OTHER, 10)).toBe(0)
  })
})

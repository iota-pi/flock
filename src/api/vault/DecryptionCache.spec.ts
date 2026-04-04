import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DecryptionCache } from './DecryptionCache'
import { syncDB } from '../db'
import * as automergeCache from '../../sync/automergeBinaryCache'

vi.mock('../db', () => ({
  syncDB: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}))

vi.mock('../../sync/automergeBinaryCache', () => ({
  setCachedAutomergeBinary: vi.fn(),
  setCachedMetadataAutomergeBinary: vi.fn(),
}))

describe('DecryptionCache', () => {
  let cache: DecryptionCache

  beforeEach(() => {
    cache = new DecryptionCache()
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cache.reset()
    vi.useRealTimers()
  })

  it('hydrates from persisted storage', async () => {
    vi.mocked(syncDB.getItem).mockResolvedValue({
      'item-1': {
        cacheKey: 'hash-1',
        item: { id: 'item-1', type: 'person', name: 'Test item' },
      },
    })

    await cache.load('acct-1')

    expect(cache.get('item-1')?.item).toMatchObject({
      id: 'item-1',
      name: 'Test item',
    })
  })

  it('sets automerge binary cache when caching an item binary', () => {
    const binary = new Uint8Array([1, 2, 3])

    cache.set('item-1', {
      cacheKey: 'hash-1',
      item: { id: 'item-1', type: 'person', name: 'A' } as any,
      automergeBinary: binary,
    })

    expect(automergeCache.setCachedAutomergeBinary).toHaveBeenCalledWith('item-1', binary)
  })

  it('debounces persistence writes', () => {
    cache.schedulePersist('acct-1')
    cache.schedulePersist('acct-1')
    cache.schedulePersist('acct-1')

    vi.advanceTimersByTime(100)
    expect(syncDB.setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(101)
    expect(syncDB.setItem).toHaveBeenCalledTimes(1)
  })

  it('evicts oldest entries when exceeding max cache size', () => {
    for (let i = 0; i < 2005; i += 1) {
      cache.set(`item-${i}`, {
        cacheKey: `hash-${i}`,
        item: { id: `item-${i}`, type: 'person', name: `Item ${i}` } as any,
      })
    }

    cache.schedulePersist('acct-1')
    vi.advanceTimersByTime(201)

    const snapshot = cache.getSnapshot()
    expect(snapshot.size).toBe(2000)
    expect(snapshot.has('item-0')).toBe(false)
    expect(snapshot.has('item-4')).toBe(false)
    expect(snapshot.has('item-5')).toBe(true)
    expect(snapshot.has('item-2004')).toBe(true)
  })

  it('sets metadata binary through automerge metadata cache adapter', () => {
    const binary = new Uint8Array([9, 8, 7])

    cache.setMetadataBinary(binary)

    expect(automergeCache.setCachedMetadataAutomergeBinary).toHaveBeenCalledWith(binary)
    expect(cache.getMetadataBinary()).toEqual(binary)
  })
})

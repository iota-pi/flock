import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}))

vi.mock('./db', () => ({
  syncDB: {
    getItem: mocks.getItem,
    setItem: mocks.setItem,
  },
}))

describe('decryption cache persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    const mod = await import('./itemReadService')
    mod.__decryptionCacheTestUtils.reset()
    vi.useRealTimers()
  })

  it('hydrates cache from persisted storage during boot initialization', async () => {
    const accountId = 'acct-a'
    const persisted = {
      'item-1': {
        cipher: 'cipher-1',
        iv: 'iv-1',
        item: {
          id: 'item-1',
          type: 'person',
          name: 'Hydrated item',
        },
      },
    }

    mocks.getItem.mockResolvedValue(persisted)

    const mod = await import('./itemReadService')
    await mod.__decryptionCacheTestUtils.load(accountId)

    const cacheSnapshot = mod.__decryptionCacheTestUtils.getSnapshot()
    expect(cacheSnapshot.get('item-1')).toEqual({
      cacheKey: 'cipher-1',
      item: persisted['item-1'].item,
    })
  })

  it('persists cache with debounce to avoid write thrashing', async () => {
    const accountId = 'acct-a'
    const persisted = {
      'item-1': {
        cipher: 'cipher-1',
        iv: 'iv-1',
        item: {
          id: 'item-1',
          type: 'person',
          name: 'Hydrated item',
        },
      },
    }

    mocks.getItem.mockResolvedValue(persisted)

    const mod = await import('./itemReadService')
    await mod.__decryptionCacheTestUtils.load(accountId)

    mod.__decryptionCacheTestUtils.schedulePersist(accountId)
    mod.__decryptionCacheTestUtils.schedulePersist(accountId)
    mod.__decryptionCacheTestUtils.schedulePersist(accountId)

    await vi.advanceTimersByTimeAsync(201)

    expect(mocks.setItem).toHaveBeenCalledTimes(1)
    expect(mocks.setItem).toHaveBeenCalledWith(
      'decryption-cache_acct-a',
      expect.objectContaining({
        'item-1': {
          cacheKey: 'cipher-1',
          item: persisted['item-1'].item,
        },
      }),
    )
  })

  it('clears and re-scopes cache when loading a different account', async () => {
    mocks.getItem.mockImplementation(async (key: string) => {
      if (key === 'decryption-cache_acct-a') {
        return {
          'item-a': {
            cipher: 'cipher-a',
            iv: 'iv-a',
            item: { id: 'item-a', type: 'person', name: 'Account A item' },
          },
        }
      }

      if (key === 'decryption-cache_acct-b') {
        return {
          'item-b': {
            cipher: 'cipher-b',
            iv: 'iv-b',
            item: { id: 'item-b', type: 'person', name: 'Account B item' },
          },
        }
      }

      return null
    })

    const mod = await import('./itemReadService')

    await mod.__decryptionCacheTestUtils.load('acct-a')
    expect(mod.__decryptionCacheTestUtils.getSnapshot().has('item-a')).toBe(true)

    await mod.__decryptionCacheTestUtils.load('acct-b')
    const scopedSnapshot = mod.__decryptionCacheTestUtils.getSnapshot()

    expect(scopedSnapshot.has('item-a')).toBe(false)
    expect(scopedSnapshot.has('item-b')).toBe(true)
  })
})

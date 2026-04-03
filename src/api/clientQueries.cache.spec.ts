import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedDecryptionCache } from './vault/DecryptionCache'

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
    sharedDecryptionCache.reset()
    vi.useRealTimers()
  })

  it('hydrates cache from persisted storage during boot initialization', async () => {
    const accountId = 'acct-a'
    const persisted = {
      'item-1': {
        cacheKey: 'cipher-hash-v1:abcd1234',
        item: {
          id: 'item-1',
          type: 'person',
          name: 'Hydrated item',
        },
      },
    }

    mocks.getItem.mockResolvedValue(persisted)

    await sharedDecryptionCache.load(accountId)

    const cacheSnapshot = sharedDecryptionCache.getSnapshot()
    expect(cacheSnapshot.get('item-1')).toEqual({
      cacheKey: 'cipher-hash-v1:abcd1234',
      item: persisted['item-1'].item,
    })
  })

  it('persists cache with debounce to avoid write thrashing', async () => {
    const accountId = 'acct-a'
    const persisted = {
      'item-1': {
        cacheKey: 'cipher-hash-v1:abcd1234',
        item: {
          id: 'item-1',
          type: 'person',
          name: 'Hydrated item',
        },
      },
    }

    mocks.getItem.mockResolvedValue(persisted)

  await sharedDecryptionCache.load(accountId)

  sharedDecryptionCache.schedulePersist(accountId)
  sharedDecryptionCache.schedulePersist(accountId)
  sharedDecryptionCache.schedulePersist(accountId)

    await vi.advanceTimersByTimeAsync(201)

    expect(mocks.setItem).toHaveBeenCalledTimes(1)
    expect(mocks.setItem).toHaveBeenCalledWith(
      'decryption-cache_acct-a',
      expect.objectContaining({
        'item-1': {
          cacheKey: 'cipher-hash-v1:abcd1234',
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
            cacheKey: 'cipher-hash-v1:aaaa1111',
            item: { id: 'item-a', type: 'person', name: 'Account A item' },
          },
        }
      }

      if (key === 'decryption-cache_acct-b') {
        return {
          'item-b': {
            cacheKey: 'cipher-hash-v1:bbbb2222',
            item: { id: 'item-b', type: 'person', name: 'Account B item' },
          },
        }
      }

      return null
    })

  await sharedDecryptionCache.load('acct-a')
  expect(sharedDecryptionCache.getSnapshot().has('item-a')).toBe(true)

  await sharedDecryptionCache.load('acct-b')
  const scopedSnapshot = sharedDecryptionCache.getSnapshot()

    expect(scopedSnapshot.has('item-a')).toBe(false)
    expect(scopedSnapshot.has('item-b')).toBe(true)
  })
})

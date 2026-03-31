import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>()

  return {
    store,
    putMutate: vi.fn(),
    putManyMutate: vi.fn(),
    updateMetadataMutate: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    decryptObject: vi.fn(),
    encryptObject: vi.fn(),
    fetchMany: vi.fn(),
    decryptVaultItems: vi.fn(),
    setOfflineQueueLength: vi.fn(),
    setIsSyncing: vi.fn(),
    setDlqCount: vi.fn(),
    setMessage: vi.fn(),
  }
})

vi.mock('../env', () => ({
  default: {
    PUBLIC_URL: '',
    VAPID_PUBLIC_KEY: '',
    VAULT_ENDPOINT: 'http://vault.test',
  },
}))

vi.mock('./db', () => ({
  syncDB: {
    getItem: vi.fn(async (key: string) => mocks.store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      mocks.store.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      mocks.store.delete(key)
    }),
  },
}))

vi.mock('./trpcClient', () => ({
  trpcClient: {
    items: {
      put: { mutate: mocks.putMutate },
      putMany: { mutate: mocks.putManyMutate },
    },
    accounts: {
      updateMetadata: { mutate: mocks.updateMetadataMutate },
    },
  },
}))

vi.mock('./queryClient', () => ({
  queryClient: {
    setQueryData: mocks.setQueryData,
    getQueryData: mocks.getQueryData,
  },
  queryKeys: {
    items: ['items'],
  },
}))

vi.mock('./vault', () => ({
  decryptObject: mocks.decryptObject,
  encryptObject: mocks.encryptObject,
}))

vi.mock('./vault/client', () => ({
  fetchMany: mocks.fetchMany,
}))

vi.mock('./queries', () => ({
  decryptVaultItems: mocks.decryptVaultItems,
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn(() => 'acct-1'),
}))

vi.mock('../state/uiStore', () => ({
  useUiStore: {
    getState: () => ({
      setOfflineQueueLength: mocks.setOfflineQueueLength,
      setIsSyncing: mocks.setIsSyncing,
      setDlqCount: mocks.setDlqCount,
      setMessage: mocks.setMessage,
    }),
  },
}))

describe('offlineQueue', () => {
  beforeEach(() => {
    mocks.store.clear()
    vi.clearAllMocks()
    mocks.putMutate.mockResolvedValue({ success: true })
    mocks.putManyMutate.mockResolvedValue({ success: true })

    let cacheItems: unknown[] = []
    mocks.getQueryData.mockImplementation(() => cacheItems)
    mocks.setQueryData.mockImplementation((_key, updater) => {
      if (typeof updater === 'function') {
        cacheItems = updater(cacheItems)
      } else {
        cacheItems = updater
      }
      return cacheItems
    })
  })

  it('moves failed non-conflict mutation to DLQ and rolls back cache base state', async () => {
    const { enqueueMutation, processOfflineQueue } = await import('./offlineQueue')
    const { readDeadLetterQueue, readQueue } = await import('./offlineQueueStore')

    const baseState = {
      id: 'item-1',
      type: 'person',
      name: 'Before edit',
      version: 2,
    }

    await enqueueMutation(
      'items.put',
      {
        account: 'acct-1',
        item: 'item-1',
        cipher: 'cipher-a',
        iv: 'iv-a',
        modified: 1,
        type: 'person',
        version: 3,
      },
      { baseState: baseState as any },
    )

    mocks.putMutate.mockRejectedValue(new Error('500 Internal Server Error'))

    await processOfflineQueue()

    const deadLetterQueue = await readDeadLetterQueue()
    const queue = await readQueue()

    expect(deadLetterQueue).toHaveLength(1)
    expect(deadLetterQueue[0].mutationType).toBe('items.put')
    expect(queue).toHaveLength(0)
    expect(mocks.setQueryData).toHaveBeenCalled()
  })

  it('chunks putMany payloads of 120 items into 50/50/20 requests', async () => {
    const { enqueueMutation, processOfflineQueue } = await import('./offlineQueue')
    const { readQueue } = await import('./offlineQueueStore')

    const batch = Array.from({ length: 120 }, (_, index) => ({
      id: `item-${index + 1}`,
      cipher: `cipher-${index + 1}`,
      iv: `iv-${index + 1}`,
      modified: index + 1,
      type: 'person',
      version: 1,
    }))

    mocks.putManyMutate.mockResolvedValue({ success: true })

    await enqueueMutation('items.putMany', {
      account: 'acct-1',
      items: batch,
    })

    await processOfflineQueue()

    expect(mocks.putManyMutate).toHaveBeenCalledTimes(3)
    expect(mocks.putManyMutate.mock.calls[0][0].items).toHaveLength(50)
    expect(mocks.putManyMutate.mock.calls[1][0].items).toHaveLength(50)
    expect(mocks.putManyMutate.mock.calls[2][0].items).toHaveLength(20)

    const queue = await readQueue()
    expect(queue).toHaveLength(0)
  })
})
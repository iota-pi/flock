import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedDecryptionCache } from './vault/DecryptionCache'

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  decryptItemsInWorker: vi.fn(),
  configureDecryptionWorkerCallbacks: vi.fn(),
  maybeCompactItemInWorker: vi.fn(),
}))

vi.mock('./db', () => ({
  syncDB: {
    getItem: mocks.getItem,
    setItem: mocks.setItem,
  },
}))

vi.mock('./util', () => ({
  getAccountId: () => 'acct-test',
}))

vi.mock('./vault', () => ({
  getVaultKey: vi.fn(() => ({}) as CryptoKey),
  decryptObject: vi.fn(),
}))

vi.mock('../workers/decryptionWorkerManager', () => ({
  configureDecryptionWorkerCallbacks: mocks.configureDecryptionWorkerCallbacks,
  decryptItemsInWorker: mocks.decryptItemsInWorker,
  evaluateHistoryInWorker: vi.fn(),
  maybeCompactItemInWorker: mocks.maybeCompactItemInWorker,
  compactItemInWorker: vi.fn(),
  resolveQueueConflictInWorker: vi.fn(),
  rescueStaleCompactedBranchInWorker: vi.fn(),
}))

describe('decryptVaultItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getItem.mockResolvedValue(null)
    mocks.maybeCompactItemInWorker.mockResolvedValue(undefined)
    vi.stubGlobal('Worker', class MockWorker {})
  })

  afterEach(() => {
    sharedDecryptionCache.reset()
    vi.unstubAllGlobals()
  })

  it('decrypts with manager then reuses cache on next call', async () => {
    const envelope = {
      item: 'item-1',
      cipher: 'cipher-value',
      metadata: {
        type: 'person' as const,
        iv: 'iv-value',
        modified: Date.now(),
      },
    }

    mocks.decryptItemsInWorker.mockResolvedValue([
      {
        id: 'item-1',
        type: 'person',
        name: 'Alice',
      },
    ])

    const mod = await import('./itemReadService')

    const first = await mod.decryptVaultItems([envelope])
    const second = await mod.decryptVaultItems([envelope])

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ id: 'item-1', type: 'person', name: 'Alice' })
    expect(second).toHaveLength(1)
    expect(mocks.decryptItemsInWorker).toHaveBeenCalledTimes(1)
    expect(mocks.configureDecryptionWorkerCallbacks).toHaveBeenCalledTimes(1)
  })
})

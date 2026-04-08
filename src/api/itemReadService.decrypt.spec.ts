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
    const envelopes = [
      {
        item: 'item-1',
        cipher: 'cipher-value-1',
        metadata: {
          type: 'person' as const,
          iv: 'iv-value-1',
          modified: Date.now(),
        },
      },
      {
        item: 'item-2',
        cipher: 'cipher-value-2',
        metadata: {
          type: 'person' as const,
          iv: 'iv-value-2',
          modified: Date.now(),
        },
      },
    ]

    mocks.decryptItemsInWorker.mockResolvedValue([
      {
        id: 'item-1',
        type: 'person',
        name: 'Alice',
      },
      {
        id: 'item-2',
        type: 'person',
        name: 'Bob',
      },
    ])

    const mod = await import('./itemReadService')
    const schedulePersistSpy = vi.spyOn(sharedDecryptionCache, 'schedulePersist')

    const first = await mod.decryptVaultItems(envelopes)
    const second = await mod.decryptVaultItems(envelopes)

    expect(first).toHaveLength(2)
    expect(first[0]).toMatchObject({ id: 'item-1', type: 'person', name: 'Alice' })
    expect(first[1]).toMatchObject({ id: 'item-2', type: 'person', name: 'Bob' })
    expect(second).toHaveLength(2)
    expect(mocks.decryptItemsInWorker).toHaveBeenCalledTimes(1)
    expect(mocks.configureDecryptionWorkerCallbacks).toHaveBeenCalledTimes(1)
    expect(schedulePersistSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to envelope metadata type when worker item omits type', async () => {
    const envelopes = [
      {
        item: 'item-1',
        cipher: 'cipher-value-1',
        metadata: {
          type: 'person' as const,
          iv: 'iv-value-1',
          modified: Date.now(),
        },
      },
    ]

    mocks.decryptItemsInWorker.mockResolvedValue([
      {
        id: 'item-1',
        name: 'Alice',
      },
    ])

    const mod = await import('./itemReadService')
    const result = await mod.decryptVaultItems(envelopes)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'item-1',
      type: 'person',
      name: 'Alice',
    })
  })

  it('returns valid decrypted items even when one worker item is malformed', async () => {
    const envelopes = [
      {
        item: 'good-item',
        cipher: 'cipher-value-good',
        metadata: {
          type: 'person' as const,
          iv: 'iv-value-good',
          modified: Date.now(),
        },
      },
      {
        item: 'bad-item',
        cipher: 'cipher-value-bad',
        metadata: {
          type: 'invalid' as any,
          iv: 'iv-value-bad',
          modified: Date.now(),
        },
      },
    ]

    mocks.decryptItemsInWorker.mockResolvedValue([
      {
        id: 'good-item',
        type: 'person',
        name: 'Good',
      },
      {
        id: 'bad-item',
        name: 'Bad',
      },
    ])

    const mod = await import('./itemReadService')
    const result = await mod.decryptVaultItems(envelopes)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'good-item',
      type: 'person',
      name: 'Good',
    })
  })
})

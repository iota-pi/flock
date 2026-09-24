import { ItemId } from 'src/shared/schemas/items'
import { buildSnapshot, isTransientVaultError, TRANSIENT_VAULT_ERROR_SUBSTRINGS, SnapshotBuilder } from './snapshotBuilder'
import { VaultNotInitializedError } from '../../api/vault'

const mockEncryptBytes = vi.fn()
const mockNormalizeItemSnapshot = vi.fn()
const mockSave = vi.fn()
const mockToAutomergeUrlFromItemId = vi.fn()

vi.mock('../../api/vault', () => {
  class MockVaultNotInitializedError extends Error {
    name = 'VaultNotInitializedError'
  }
  return {
    encryptBytes: (...args: any[]) => mockEncryptBytes(...args),
    VaultNotInitializedError: MockVaultNotInitializedError,
  }
})

vi.mock('@automerge/automerge/slim', () => ({
  save: (...args: any[]) => mockSave(...args),
  getHeads: vi.fn().mockReturnValue(['mock-head']),
}))

vi.mock('./docStore', () => ({
  normalizeItemSnapshot: (...args: any[]) => mockNormalizeItemSnapshot(...args),
}))

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: (...args: any[]) => mockToAutomergeUrlFromItemId(...args),
}))

describe('buildSnapshot helper function', () => {
  let mockRepo: any
  let mockHandle: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'topic' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    mockToAutomergeUrlFromItemId.mockReturnValue('automerge:item-1')
    mockSave.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockEncryptBytes.mockResolvedValue({
      iv: 'mock-iv',
      cipher: 'mock-cipher',
      kver: '1',
    })
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
    })
  })

  it('builds a snapshot successfully under normal conditions', async () => {
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)

    expect(result).toEqual({
      type: 'success',
      snapshot: {
        itemId: 'item-1',
        snapshot: { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' },
        snapshotCursor: 42,
        type: 'topic',
        modified: expect.any(Number),
        deleted: undefined,
      },
      heads: ['mock-head'],
    })

    expect(mockToAutomergeUrlFromItemId).toHaveBeenCalledWith('item-1')
    expect(mockRepo.find).toHaveBeenCalledWith('automerge:item-1')
    expect(mockSave).toHaveBeenCalledWith({ id: 'item-1', type: 'topic' })
    expect(mockEncryptBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(mockNormalizeItemSnapshot).toHaveBeenCalledWith('item-1', { id: 'item-1', type: 'topic' })
  })

  it('captures snapshot timestamp prior to async encryption to prevent stale timestamp masking', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      mockEncryptBytes.mockImplementation(async () => {
        // Simulate async encryption delay where time advances to T3
        vi.setSystemTime(3000)
        return { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' }
      })

      const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
      expect(result.type).toBe('success')
      // Timestamp must be T1 (1000), not T3 (3000)
      expect((result as Extract<typeof result, { type: 'success' }>).snapshot.modified).toBe(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns error if repo.find throws or returns undefined', async () => {
    mockRepo.find.mockRejectedValue(new Error('not found'))
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'error', reason: 'Document handle not found' })

    mockRepo.find.mockResolvedValue(undefined)
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'error', reason: 'Document handle not found' })
  })

  it('returns not-ready if document handle is not ready', async () => {
    mockHandle.isReady.mockReturnValue(false)
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('returns error if doc is missing or saving binary is empty', async () => {
    mockHandle.doc.mockReturnValue(undefined)
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'error', reason: 'Document data not available' })

    mockHandle.doc.mockReturnValue({ id: 'item-1' })
    mockSave.mockReturnValue(new Uint8Array([]))
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'error', reason: 'Failed to serialize document binary' })
  })

  it('returns error if normalizeItemSnapshot returns null', async () => {
    mockNormalizeItemSnapshot.mockReturnValue(null)
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'error', reason: 'Failed to normalize item snapshot' })
  })

  it('correctly reports deleted status if document is deleted', async () => {
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
      deleted: true,
    })

    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({
      type: 'success',
      snapshot: expect.objectContaining({
        deleted: true,
      }),
      heads: ['mock-head'],
    })
  })

  it('returns not-ready if encryptBytes throws VaultNotInitializedError or Vault is locked', async () => {
    mockEncryptBytes.mockRejectedValueOnce(new VaultNotInitializedError())
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'not-ready' })

    mockEncryptBytes.mockRejectedValueOnce(new Error('Vault is locked'))
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('propagates non-transient encryptBytes exception (caller handles it)', async () => {
    const error = new Error('Crypto error')
    mockEncryptBytes.mockRejectedValue(error)

    await expect(buildSnapshot(mockRepo, 'item-1' as ItemId, 42)).rejects.toThrow('Crypto error')
  })
})

describe('isTransientVaultError', () => {
  it('returns false for falsy values', () => {
    expect(isTransientVaultError(null)).toBe(false)
    expect(isTransientVaultError(undefined)).toBe(false)
    expect(isTransientVaultError('')).toBe(false)
  })

  it('returns true for VaultNotInitializedError instance or error with that name', () => {
    expect(isTransientVaultError(new VaultNotInitializedError())).toBe(true)
    const err = new Error('Some message')
    err.name = 'VaultNotInitializedError'
    expect(isTransientVaultError(err)).toBe(true)
  })

  it('returns true for each substring in TRANSIENT_VAULT_ERROR_SUBSTRINGS', () => {
    for (const substring of TRANSIENT_VAULT_ERROR_SUBSTRINGS) {
      expect(isTransientVaultError(new Error(`Prefix ${substring.toUpperCase()} suffix`))).toBe(true)
      expect(isTransientVaultError(`Raw string containing ${substring}`)).toBe(true)
    }
  })

  it('returns false for non-transient errors', () => {
    expect(isTransientVaultError(new Error('Corrupt block detected'))).toBe(false)
    expect(isTransientVaultError(new Error('Permission denied'))).toBe(false)
    expect(isTransientVaultError('Unexpected EOF')).toBe(false)
  })
})

describe('SnapshotBuilder class', () => {
  let mockRepo: any
  let mockHandle: any
  let builder: SnapshotBuilder

  beforeEach(() => {
    vi.clearAllMocks()

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'topic' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    mockToAutomergeUrlFromItemId.mockReturnValue('automerge:item-1')
    mockSave.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockEncryptBytes.mockResolvedValue({
      iv: 'mock-iv',
      cipher: 'mock-cipher',
      kver: '1',
    })
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
    })

    builder = new SnapshotBuilder(mockRepo)
  })

  it('builds snapshot successfully', async () => {
    const result = await builder.build('item-1' as ItemId, 42)
    expect(result.type).toBe('success')
  })

  it('handles transient vault error by returning not-ready', async () => {
    mockEncryptBytes.mockRejectedValue(new VaultNotInitializedError())
    const result = await builder.build('item-1' as ItemId, 42)
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('handles non-transient error by returning error result with reason', async () => {
    mockEncryptBytes.mockRejectedValue(new Error('Non-transient encryption error'))
    const result = await builder.build('item-1' as ItemId, 42)
    expect(result).toEqual({
      type: 'error',
      reason: 'Non-transient encryption error',
    })
  })

  it('estimates snapshot size properly', () => {
    const snapshot = {
      itemId: 'item-1' as ItemId,
      snapshot: { cipher: '1234567890', iv: '1234', kver: '1' },
      snapshotCursor: 10,
      type: 'note',
      modified: 12345,
    }
    const size = builder.estimateSize(snapshot)
    expect(size).toBe(10 + 4 + 6 + 128)
  })
})



import { ItemId, type VaultSnapshotInput } from '@vault/shared'
import {
  buildSnapshot,
  estimateSnapshotSize,
  SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS,
  SnapshotBuilder,
  toTombstoneSnapshot,
} from './snapshotBuilder'
import { classifySyncError, TRANSIENT_VAULT_ERROR_SUBSTRINGS } from '../utils/errorClassifier'
import { VaultNotInitializedError } from '../../api/Keyring'
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'
import { spyOnExports } from '../../../test/moduleMocks'
import { passthroughCodec, type DocCodec } from './domain'
import * as docStoreModule from './docStore'
import * as automergeModule from './utils/automerge'
import * as Automerge from '@automerge/automerge/slim'

const testCodec: DocCodec = { ...passthroughCodec }

const mockEncryptBytes = vi.fn()
const mockNormalizeItemSnapshot = vi.fn()
const mockSave = vi.fn()
const mockToAutomergeUrlFromItemId = vi.fn()

const keys = createMockKeyProvider({ ...createMockVault(), encryptBytes: mockEncryptBytes })

beforeEach(() => {
  spyOnExports(Automerge, {
    save: (...args: any[]) => mockSave(...args),
    getHeads: vi.fn().mockReturnValue(['mock-head']),
  })
  spyOnExports(docStoreModule, {
    normalizeItemSnapshot: (...args: any[]) => mockNormalizeItemSnapshot(...args),
  })
  spyOnExports(automergeModule, {
    toAutomergeUrlFromItemId: (...args: any[]) => mockToAutomergeUrlFromItemId(...args),
  })
})

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
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: testCodec })

    expect(result).toEqual({
      type: 'success',
      snapshot: {
        itemId: 'item-1',
        snapshot: { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' },
        snapshotCursor: 42,
        modified: expect.any(Number),
        deleted: undefined,
      },
      heads: ['mock-head'],
    })

    expect(mockToAutomergeUrlFromItemId).toHaveBeenCalledWith('item-1')
    expect(mockRepo.find).toHaveBeenCalledWith('automerge:item-1', { signal: expect.any(AbortSignal) })
    expect(mockSave).toHaveBeenCalledWith({ id: 'item-1', type: 'topic' })
    expect(mockEncryptBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'item-1')
    expect(mockNormalizeItemSnapshot).toHaveBeenCalledWith('item-1', { id: 'item-1', type: 'topic' }, testCodec)
  })

  describe('document lookup bounds', () => {
    /** Like automerge-repo's find for a document whose handle never becomes ready: it settles only on abort */
    const pendingFind = (_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('aborts the lookup when the caller aborts', async () => {
      const controller = new AbortController()
      await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { signal: controller.signal, codec: passthroughCodec })

      const lookupSignal: AbortSignal = mockRepo.find.mock.calls[0][1].signal
      expect(lookupSignal.aborted).toBe(false)
      controller.abort()
      expect(lookupSignal.aborted).toBe(true)
    })

    it('returns an error when the lookup never settles', async () => {
      mockRepo.find.mockImplementation(pendingFind)

      const resultPromise = buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS - 1)
      let settled = false
      void resultPromise.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(resultPromise).resolves.toEqual({
        type: 'error',
        reason: `Document lookup timed out after ${SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS}ms`,
      })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('rethrows an abort of the caller signal rather than reporting an error', async () => {
      mockRepo.find.mockImplementation(pendingFind)
      const controller = new AbortController()

      const resultPromise = buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { signal: controller.signal, codec: passthroughCodec })
      const caught = resultPromise.catch((error: unknown) => error)
      controller.abort()
      expect(await caught).toMatchObject({ name: 'AbortError' })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('does not look the document up when the caller signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(
        buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { signal: controller.signal, codec: passthroughCodec }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(mockRepo.find).not.toHaveBeenCalled()
    })

    it('SnapshotBuilder reports a timed-out lookup as an error and propagates a caller abort', async () => {
      mockRepo.find.mockImplementation(pendingFind)
      const builder = new SnapshotBuilder(mockRepo, keys, passthroughCodec)

      const timedOut = builder.build('item-1' as ItemId, 42)
      await vi.advanceTimersByTimeAsync(SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS)
      await expect(timedOut).resolves.toEqual(expect.objectContaining({ type: 'error' }))

      const controller = new AbortController()
      const aborted = builder.build('item-1' as ItemId, 42, { signal: controller.signal })
      const caught = aborted.catch((error: unknown) => error)
      controller.abort()
      expect(await caught).toMatchObject({ name: 'AbortError' })
    })
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

      const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
      expect(result.type).toBe('success')
      // Timestamp must be T1 (1000), not T3 (3000)
      expect((result as Extract<typeof result, { type: 'success' }>).snapshot.modified).toBe(1000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns error if repo.find throws or returns undefined', async () => {
    mockRepo.find.mockRejectedValue(new Error('not found'))
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'error', reason: 'Document handle not found' })

    mockRepo.find.mockResolvedValue(undefined)
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'error', reason: 'Document handle not found' })
  })

  it('returns not-ready if document handle is not ready', async () => {
    mockHandle.isReady.mockReturnValue(false)
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('returns error if doc is missing or saving binary is empty', async () => {
    mockHandle.doc.mockReturnValue(undefined)
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'error', reason: 'Document data not available' })

    mockHandle.doc.mockReturnValue({ id: 'item-1' })
    mockSave.mockReturnValue(new Uint8Array([]))
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'error', reason: 'Failed to serialize document binary' })
  })

  it('returns error if normalizeItemSnapshot returns null', async () => {
    mockNormalizeItemSnapshot.mockReturnValue(null)
    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'error', reason: 'Failed to normalize item snapshot' })
  })

  it('correctly reports deleted status if document is deleted', async () => {
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
      deleted: true,
    })

    const result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
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
    let result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'not-ready' })

    mockEncryptBytes.mockRejectedValueOnce(new Error('Vault is locked'))
    result = await buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('propagates non-transient encryptBytes exception (caller handles it)', async () => {
    const error = new Error('Crypto error')
    mockEncryptBytes.mockRejectedValue(error)

    await expect(buildSnapshot(mockRepo, 'item-1' as ItemId, 42, keys, { codec: passthroughCodec })).rejects.toThrow('Crypto error')
  })
})

describe('classifySyncError isTransientVault', () => {
  const isTransientVaultError = (error: unknown) => classifySyncError(error).isTransientVault

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

    builder = new SnapshotBuilder(mockRepo, keys, passthroughCodec)
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
      modified: 12345,
    }
    const size = builder.estimateSize(snapshot)
    expect(size).toBe(10 + 4 + 6 + 128)
  })
})

describe('toTombstoneSnapshot', () => {
  const base = {
    itemId: 'item-1' as ItemId,
    snapshot: { cipher: 'abc', iv: '123', kver: '1' },
    snapshotCursor: 7,
    modified: 1234,
  }

  it('strips the snapshot payload and keeps the other fields', () => {
    const tombstone = toTombstoneSnapshot({ ...base, deleted: true })

    expect(tombstone).toEqual({
      itemId: 'item-1',
      snapshotCursor: 7,
      modified: 1234,
      deleted: true,
    })
    expect('snapshot' in tombstone).toBe(false)
  })

  it('throws when the snapshot is not deleted', () => {
    expect(() => toTombstoneSnapshot(base)).toThrow('Cannot create a tombstone')
  })
})

describe('estimateSnapshotSize', () => {
  it('estimates snapshot size based on cipher, iv, itemId, and overhead without JSON.stringify', () => {
    const snapshot: VaultSnapshotInput = {
      itemId: 'item-1' as ItemId,
      snapshot: { iv: 'iv-12345678', cipher: 'a'.repeat(100), kver: '1' },
      snapshotCursor: 1,
      modified: 1000,
    }
    // 100 (cipher) + 11 (iv) + 6 (itemId) + 128 (base overhead) = 245
    expect(estimateSnapshotSize(snapshot)).toBe(245)
  })

  it('handles empty or missing optional fields safely', () => {
    const snapshot: VaultSnapshotInput = {
      itemId: '' as ItemId,
      snapshot: { iv: '', cipher: '' },
      snapshotCursor: 0,
      modified: 0,
    }
    expect(estimateSnapshotSize(snapshot)).toBe(128)
  })
})

import type { Mock } from 'vitest'
import type { AutomergeDocStore } from './docStore'
import type { ItemId, VaultSnapshotInput } from '@vault/shared'
import {
  estimateSnapshotSize,
  SnapshotBuilder,
  toTombstoneSnapshot,
} from './SnapshotBuilder'
import { classifySyncError, TRANSIENT_VAULT_ERROR_SUBSTRINGS } from '../utils/errorClassifier'
import { VaultNotInitializedError } from '../keys/Keyring'
import { createMockKeyProvider, createMockVault, noLogCoverage } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import { passthroughCodec, type DocCodec } from './domain'
import * as docStoreModule from './docStore'
import * as Automerge from '@automerge/automerge/slim'

const testCodec: DocCodec = { ...passthroughCodec }

const mockEncryptBytes = vi.fn()
const mockNormalizeItemSnapshot = vi.fn()
const mockSave = vi.fn()

const keys = createMockKeyProvider({ ...createMockVault(), encryptBytes: mockEncryptBytes })

beforeEach(() => {
  spyOnExports(Automerge, {
    save: (...args: any[]) => mockSave(...args),
    getHeads: vi.fn().mockReturnValue(['mock-head']),
  })
  spyOnExports(docStoreModule, {
    normalizeItemSnapshot: (...args: any[]) => mockNormalizeItemSnapshot(...args),
  })
})

describe('SnapshotBuilder', () => {
  let mockDocStore: { findHandle: Mock<AutomergeDocStore['findHandle']> }
  let mockHandle: any
  let builder: SnapshotBuilder

  beforeEach(() => {
    vi.clearAllMocks()

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'topic' }),
    }

    mockDocStore = {
      findHandle: vi.fn().mockResolvedValue(mockHandle),
    }

    mockSave.mockReturnValue(new Uint8Array([1, 2, 3]))
    mockEncryptBytes.mockResolvedValue({
      iv: 'mock-iv',
      cipher: 'mock-cipher',
      kver: '1',
    })
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
    })

    builder = new SnapshotBuilder(mockDocStore, keys, passthroughCodec, noLogCoverage)
  })

  it('defers an item whose changes have not reached the log, without saving it', async () => {
    const coverage = { isCovered: vi.fn().mockReturnValue(false) }
    const deferring = new SnapshotBuilder(mockDocStore, keys, passthroughCodec, coverage)


    const result = await deferring.build('item-1' as ItemId)

    expect(result).toEqual({ type: 'deferred', reason: 'unpushed' })
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('builds a snapshot successfully under normal conditions', async () => {
    const result = await new SnapshotBuilder(mockDocStore, keys, testCodec, noLogCoverage).build('item-1' as ItemId)

    expect(result).toEqual({
      type: 'success',
      snapshot: {
        itemId: 'item-1',
        snapshot: { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' },
        deleted: undefined,
        heads: { iv: 'mock-iv', cipher: 'mock-cipher', kver: '1' },
      },
      heads: ['mock-head'],
    })

    expect(mockDocStore.findHandle).toHaveBeenCalledWith('item-1')
    expect(mockSave).toHaveBeenCalledWith({ id: 'item-1', type: 'topic' })
    expect(mockEncryptBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 'item-1')
    expect(mockEncryptBytes).toHaveBeenCalledWith(new TextEncoder().encode('["mock-head"]'), 'item-1', 'heads')
    expect(mockNormalizeItemSnapshot).toHaveBeenCalledWith('item-1', { id: 'item-1', type: 'topic' }, testCodec)
  })

  describe('document lookup', () => {
    it('rethrows an abort of the caller signal while the lookup is pending, rather than reporting an error', async () => {
      mockDocStore.findHandle.mockReturnValue(new Promise(() => {}))
      const controller = new AbortController()

      const resultPromise = builder.build('item-1' as ItemId, { signal: controller.signal })
      const caught = resultPromise.catch((error: unknown) => error)
      controller.abort()
      expect(await caught).toMatchObject({ name: 'AbortError' })
    })

    it('does not look the document up when the caller signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(
        builder.build('item-1' as ItemId, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(mockDocStore.findHandle).not.toHaveBeenCalled()
    })

    it("returns an error when the doc store can't find the document", async () => {
      mockDocStore.findHandle.mockResolvedValue(undefined)
      const result = await builder.build('item-1' as ItemId)
      expect(result).toEqual({ type: 'error', reason: 'Document handle not found' })
    })
  })

  it('returns error if doc is missing or saving binary is empty', async () => {
    mockHandle.doc.mockReturnValue(undefined)
    let result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({ type: 'error', reason: 'Document data not available' })

    mockHandle.doc.mockReturnValue({ id: 'item-1' })
    mockSave.mockReturnValue(new Uint8Array([]))
    result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({ type: 'error', reason: 'Failed to serialize document binary' })
  })

  it('returns error if normalizeItemSnapshot returns null', async () => {
    mockNormalizeItemSnapshot.mockReturnValue(null)
    const result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({ type: 'error', reason: 'Failed to normalize item snapshot' })
  })

  it('correctly reports deleted status if document is deleted', async () => {
    mockNormalizeItemSnapshot.mockReturnValue({
      type: 'topic',
      deleted: true,
    })

    const result = await builder.build('item-1' as ItemId)
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
    let result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({ type: 'not-ready' })

    mockEncryptBytes.mockRejectedValueOnce(new Error('Vault is locked'))
    result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({ type: 'not-ready' })
  })

  it('handles non-transient error by returning error result with reason', async () => {
    mockEncryptBytes.mockRejectedValue(new Error('Non-transient encryption error'))
    const result = await builder.build('item-1' as ItemId)
    expect(result).toEqual({
      type: 'error',
      reason: 'Non-transient encryption error',
    })
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

describe('toTombstoneSnapshot', () => {
  const base = {
    itemId: 'item-1' as ItemId,
    snapshot: { cipher: 'abc', iv: '123', kver: '1' },
  }

  it('strips the snapshot payload and keeps the item ID', () => {
    const tombstone = toTombstoneSnapshot({ ...base, deleted: true })

    expect(tombstone).toEqual({
      itemId: 'item-1',
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
    }
    // 100 (cipher) + 11 (iv) + 6 (itemId) + 128 (base overhead) = 245
    expect(estimateSnapshotSize(snapshot)).toBe(245)
  })

  it('handles empty or missing optional fields safely', () => {
    const snapshot: VaultSnapshotInput = {
      itemId: '' as ItemId,
      snapshot: { iv: '', cipher: '' },
    }
    expect(estimateSnapshotSize(snapshot)).toBe(128)
  })
})

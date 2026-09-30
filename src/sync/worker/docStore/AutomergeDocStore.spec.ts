import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Repo, DocHandle } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import {
  AutomergeDocStore,
  normalizeItemSnapshot,
  type DocStorageChecker,
  type RepoDoc,
} from './AutomergeDocStore'
import { AutomergeIndexManager } from './AutomergeIndexManager'
import { IndexStore } from '../stores/IndexStore'
import { WorkerInternalEventHub } from '../SyncEventHub'
import { SYNC_TIMEOUTS } from '../../syncConfig'
import {
  toAutomergeUrlFromItemId,
  toDocumentIdFromItemId,
  ACCOUNT_INDEX_DOCUMENT_ID,
  type BackupDocId,
} from '../utils/automerge'
import { ItemId } from '../../../shared/schemas/items'
import type { Item } from '../../../state/items'

function createTestItem(id: ItemId, overrides: Partial<Item> = {}): Item {
  return {
    id,
    type: 'person',
    name: `Name ${id}`,
    description: `Desc ${id}`,
    created: 1000,
    archived: false,
    prayerFrequency: 'none',
    notes: [],
    prayedFor: [],
    ...overrides,
  } as Item
}

function createDocBinary(id: ItemId, overrides: Partial<Item> = {}): Uint8Array {
  const item = createTestItem(id, overrides)
  const doc = Automerge.change(Automerge.init<Record<string, unknown>>(), d => {
    for (const [key, value] of Object.entries(item)) {
      d[key] = value
    }
  })
  return Automerge.save(doc)
}

describe('AutomergeDocStore Unit Tests', () => {
  let repo: Repo
  let docStore: AutomergeDocStore

  beforeEach(() => {
    repo = new Repo()
    docStore = new AutomergeDocStore(repo)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await docStore.shutdown()
  })

  // =========================================================================
  // 1. hydrateAutomergeDocumentBinary fallback merge logic (4 branches)
  // =========================================================================
  describe('hydrateAutomergeDocumentBinary (4 branches and input guards)', () => {
    it('returns empty result when itemId is invalid or empty string', async () => {
      const binary = createDocBinary('valid-id' as ItemId)
      const resEmpty = await docStore.hydrateAutomergeDocumentBinary('' as ItemId, binary)
      expect(resEmpty).toEqual({ hasLocalChanges: false, incomingHeads: [] })

      const resWhitespace = await docStore.hydrateAutomergeDocumentBinary('   ' as ItemId, binary)
      expect(resWhitespace).toEqual({ hasLocalChanges: false, incomingHeads: [] })
    })

    it('returns empty result when binary is not a Uint8Array or has zero bytes', async () => {
      // @ts-expect-error invalid binary test
      const resNull = await docStore.hydrateAutomergeDocumentBinary('item-1', null)
      expect(resNull).toEqual({ hasLocalChanges: false, incomingHeads: [] })

      const resEmpty = await docStore.hydrateAutomergeDocumentBinary('item-1', new Uint8Array(0))
      expect(resEmpty).toEqual({ hasLocalChanges: false, incomingHeads: [] })
    })

    it('Branch 1: merges into ready existingHandle and reports hasLocalChanges: true when local doc has divergent edits', async () => {
      const itemId = 'branch1-divergent' as ItemId
      const baseBinary = createDocBinary(itemId, { name: 'Base Name', description: 'Base Desc' })

      // Seed initial base document in docStore
      await docStore.seedImportedDocument(itemId, baseBinary)

      // Make a local edit in docStore
      await docStore.changeDocument(itemId, draft => {
        draft.name = 'Local Name Edit'
      })

      // Create divergent remote snapshot from baseDoc
      const remoteDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.description = 'Remote Description Edit'
      })
      const remoteBinary = Automerge.save(remoteDoc)

      // Hydrate remote binary (Branch 1: existingHandle is ready)
      const result = await docStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)

      expect(result.hasLocalChanges).toBe(true)
      expect(result.incomingHeads).toEqual(Automerge.getHeads(remoteDoc))
      expect(result.isDeleted).toBeUndefined()

      // Verify that local and remote edits both exist in merged state
      const mergedItem = await docStore.getAutomergeItem(itemId)
      expect(mergedItem?.name).toBe('Local Name Edit')
      expect(mergedItem?.description).toBe('Remote Description Edit')
    })

    it('Branch 1: reports hasLocalChanges: false when incoming snapshot is a fast-forward without local edits', async () => {
      const itemId = 'branch1-fastforward' as ItemId
      const baseBinary = createDocBinary(itemId, { name: 'Base Name' })

      await docStore.seedImportedDocument(itemId, baseBinary)

      // Remote advances baseDoc without any local edits made
      const remoteDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.name = 'Remote Advanced Name'
      })
      const remoteBinary = Automerge.save(remoteDoc)

      const result = await docStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)
      expect(result.hasLocalChanges).toBe(false)
      expect(result.incomingHeads).toEqual(Automerge.getHeads(remoteDoc))

      const item = await docStore.getAutomergeItem(itemId)
      expect(item?.name).toBe('Remote Advanced Name')
    })

    it('Branch 1: sets isDeleted: true when merged document contains deleted: true flag', async () => {
      const itemId = 'branch1-deleted' as ItemId
      const baseBinary = createDocBinary(itemId, { name: 'To Be Deleted' })
      await docStore.seedImportedDocument(itemId, baseBinary)

      const deletedDoc = Automerge.change(Automerge.load<Record<string, unknown>>(baseBinary), d => {
        d.deleted = true
      })
      const deletedBinary = Automerge.save(deletedDoc)

      const result = await docStore.hydrateAutomergeDocumentBinary(itemId, deletedBinary)
      expect(result.isDeleted).toBe(true)
    })

    it('Branch 2: merges into inMemoryHandle when handle becomes ready during async storage I/O check', async () => {
      const customRepo = new Repo()
      const itemId = 'branch2-race' as ItemId
      const documentId = toDocumentIdFromItemId(itemId)

      const baseBinary = createDocBinary(itemId, { name: 'Base Name', description: 'Base Desc' })
      const localDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.name = 'Local Edit Before Ready'
      })
      const localBinary = Automerge.save(localDoc)

      const remoteDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.description = 'Remote Description Edit'
      })
      const remoteBinary = Automerge.save(remoteDoc)

      // Simulate findHandleInternal failing / timing out
      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      // Mock storageSubsystem.loadDocData: during storage check, handle becomes ready in repo.handles
      const loadDocDataMock = vi.fn().mockImplementation(async () => {
        // Concurrency window: handle is imported into repo.handles and becomes ready
        customRepo.import(localBinary, { docId: documentId })
        return localBinary
      })

      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = { loadDocData: loadDocDataMock }

      const customStore = new AutomergeDocStore(customRepo)
      const seedSpy = vi.spyOn(customStore, 'seedImportedDocument')

      const result = await customStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)

      expect(result.hasLocalChanges).toBe(true)
      expect(result.incomingHeads).toEqual(Automerge.getHeads(remoteDoc))

      // seedImportedDocument must NOT have been called because Branch 2 merged into inMemoryHandle
      expect(seedSpy).not.toHaveBeenCalled()

      // Verify merged state on in-memory handle
      const retrieved = await customStore.getAutomergeItem(itemId)
      expect(retrieved?.name).toBe('Local Edit Before Ready')
      expect(retrieved?.description).toBe('Remote Description Edit')
    })

    it('Branch 3a: executes direct CRDT merge with local storage binary when handle lookup timed out and doc exists in storage', async () => {
      const customRepo = new Repo()
      const itemId = 'branch3a-storage-merge' as ItemId

      const baseBinary = createDocBinary(itemId, { name: 'Base', description: 'Base Desc' })
      const localDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.name = 'Local Storage Name'
      })
      const localBinary = Automerge.save(localDoc)

      const remoteDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.description = 'Remote Server Desc'
      })
      const remoteBinary = Automerge.save(remoteDoc)

      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(localBinary),
      }

      const customStore = new AutomergeDocStore(customRepo)
      const seedSpy = vi.spyOn(customStore, 'seedImportedDocument')

      const result = await customStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)

      expect(result.hasLocalChanges).toBe(true)
      expect(result.incomingHeads).toEqual(Automerge.getHeads(remoteDoc))
      expect(seedSpy).toHaveBeenCalledTimes(1)

      const mergedItem = await customStore.getAutomergeItem(itemId)
      expect(mergedItem?.name).toBe('Local Storage Name')
      expect(mergedItem?.description).toBe('Remote Server Desc')
    })

    it('Branch 3b: throws error refusing to overwrite when document is known to exist but storage binary is missing/empty', async () => {
      const customRepo = new Repo()
      const itemId = 'branch3b-missing-binary' as ItemId
      const remoteBinary = createDocBinary(itemId)

      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(undefined),
      }

      const customStore = new AutomergeDocStore(customRepo)

      await expect(
        customStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary, { knownToExist: true })
      ).rejects.toThrow(`Refusing to overwrite existing storage data for ${itemId}`)
    })

    it('Branch 3b: throws error refusing to overwrite when storage binary is corrupt and fallback CRDT merge fails', async () => {
      const customRepo = new Repo()
      const itemId = 'branch3b-corrupt-binary' as ItemId
      const remoteBinary = createDocBinary(itemId)
      const corruptBinary = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(corruptBinary),
      }

      const customStore = new AutomergeDocStore(customRepo)

      await expect(
        customStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)
      ).rejects.toThrow(`Refusing to overwrite existing storage data for ${itemId}`)
    })

    it('Branch 4: cleanly seeds imported document when document genuinely does not exist locally', async () => {
      const customRepo = new Repo()
      const itemId = 'branch4-brand-new' as ItemId
      const remoteBinary = createDocBinary(itemId, { name: 'Brand New Item' })

      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(undefined),
      }

      const customStore = new AutomergeDocStore(customRepo)
      const seedSpy = vi.spyOn(customStore, 'seedImportedDocument')

      const result = await customStore.hydrateAutomergeDocumentBinary(itemId, remoteBinary)

      expect(result.hasLocalChanges).toBe(false)
      expect(result.incomingHeads).toEqual(Automerge.getHeads(Automerge.load(remoteBinary)))
      expect(seedSpy).toHaveBeenCalledWith(itemId, remoteBinary)

      const retrieved = await customStore.getAutomergeItem(itemId)
      expect(retrieved?.name).toBe('Brand New Item')
    })
  })

  // =========================================================================
  // 2. findHandleInternal fast-path vs extended timeout behavior
  // =========================================================================
  describe('findHandleInternal and findHandle timeout cascade', () => {
    it('returns cached handle immediately if handle in repo.handles is already ready (no storage check, no repo.find)', async () => {
      const itemId = 'cache-hit-item' as ItemId
      const binary = createDocBinary(itemId)
      const docId = toDocumentIdFromItemId(itemId)

      const handle = repo.import(binary, { docId })

      const findSpy = vi.spyOn(repo, 'find')
      const storageSpy = vi.spyOn(docStore, 'hasDataInStorage')

      const retrieved = await docStore.findHandle(itemId)
      expect(retrieved).toBe(handle)
      expect(findSpy).not.toHaveBeenCalled()
      expect(storageSpy).not.toHaveBeenCalled()
    })

    it('returns undefined without calling repo.find if document does not exist in storage', async () => {
      const itemId = 'not-in-storage-item' as ItemId
      vi.spyOn(docStore, 'hasDataInStorage').mockResolvedValue(false)
      const findSpy = vi.spyOn(repo, 'find')

      const retrieved = await docStore.findHandle(itemId)
      expect(retrieved).toBeUndefined()
      expect(findSpy).not.toHaveBeenCalled()
    })

    it('fast-path success: returns handle on first timedFind attempt (docStoreFastPath) without invoking extended timeout', async () => {
      const customRepo = new Repo()
      const itemId = 'fast-path-item' as ItemId
      const otherRepo = new Repo()
      const binary = createDocBinary(itemId)
      const expectedHandle = otherRepo.import(binary)

      const findSpy = vi.spyOn(customRepo, 'find').mockResolvedValue(expectedHandle as any)
      const customStore = new AutomergeDocStore(customRepo)

      const handle = await customStore.findHandle(itemId, { knownToExist: true })

      expect(handle).toBe(expectedHandle)
      expect(findSpy).toHaveBeenCalledTimes(1)
      expect(findSpy).toHaveBeenCalledWith(
        toAutomergeUrlFromItemId(itemId),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
    })

    it('fast-path times out, but repo.handles cache became ready before extended attempt: returns cached handle without 2nd repo.find call', async () => {
      const customRepo = new Repo()
      const itemId = 'fast-path-cache-resolved' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const otherRepo = new Repo()
      const binary = createDocBinary(itemId)
      const readyHandle = otherRepo.import(binary)

      // First find call rejects (times out), but sets handle in cache as if background load completed
      const findSpy = vi.spyOn(customRepo, 'find').mockImplementationOnce(async () => {
        Object.defineProperty(customRepo, 'handles', {
          value: { [docId]: readyHandle },
          configurable: true,
          writable: true,
        })
        throw new Error('Fast path timed out')
      })

      const customStore = new AutomergeDocStore(customRepo)
      const handle = await customStore.findHandle(itemId, { knownToExist: true })

      expect(handle).toBe(readyHandle)
      // Only 1 find call was made because cache check in step 4 found the ready handle!
      expect(findSpy).toHaveBeenCalledTimes(1)
    })

    it('fast-path times out, retries with extended timeout (docStoreExtended) and succeeds', async () => {
      const customRepo = new Repo()
      const itemId = 'extended-path-success' as ItemId
      const otherRepo = new Repo()
      const binary = createDocBinary(itemId)
      const readyHandle = otherRepo.import(binary)

      // 1st call fails, 2nd call succeeds
      const findSpy = vi.spyOn(customRepo, 'find')
        .mockRejectedValueOnce(new Error('Fast path timed out'))
        .mockResolvedValueOnce(readyHandle as any)

      const customStore = new AutomergeDocStore(customRepo)
      const handle = await customStore.findHandle(itemId, { knownToExist: true })

      expect(handle).toBe(readyHandle)
      expect(findSpy).toHaveBeenCalledTimes(2)
    })

    it('both fast-path and extended timeouts fail: returns undefined when final cache check has no ready handle', async () => {
      const customRepo = new Repo()
      const itemId = 'all-timeouts-fail' as ItemId

      const findSpy = vi.spyOn(customRepo, 'find')
        .mockRejectedValueOnce(new Error('Fast path timed out'))
        .mockRejectedValueOnce(new Error('Extended path timed out'))

      const customStore = new AutomergeDocStore(customRepo)
      const handle = await customStore.findHandle(itemId, { knownToExist: true })

      expect(handle).toBeUndefined()
      expect(findSpy).toHaveBeenCalledTimes(2)
    })

    it('both timedFind calls fail, but handle became ready in cache during extended attempt (final cache check)', async () => {
      const customRepo = new Repo()
      const itemId = 'final-cache-check-item' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const otherRepo = new Repo()
      const binary = createDocBinary(itemId)
      const readyHandle = otherRepo.import(binary)

      const findSpy = vi.spyOn(customRepo, 'find')
        .mockRejectedValueOnce(new Error('Fast path timed out'))
        .mockImplementationOnce(async () => {
          Object.defineProperty(customRepo, 'handles', {
            value: { [docId]: readyHandle },
            configurable: true,
            writable: true,
          })
          throw new Error('Extended timed out')
        })

      const customStore = new AutomergeDocStore(customRepo)
      const handle = await customStore.findHandle(itemId, { knownToExist: true })

      expect(handle).toBe(readyHandle)
      expect(findSpy).toHaveBeenCalledTimes(2)
    })

    it('gracefully handles storage check throwing error in findHandleInternal: treats as not existing and returns undefined', async () => {
      const customRepo = new Repo()
      const itemId = 'storage-error-lookup' as ItemId
      const customStore = new AutomergeDocStore(customRepo)
      vi.spyOn(customStore, 'hasDataInStorage').mockRejectedValue(new Error('IDB read failure'))
      const findSpy = vi.spyOn(customRepo, 'find')

      const handle = await customStore.findHandle(itemId)
      expect(handle).toBeUndefined()
      expect(findSpy).not.toHaveBeenCalled()
    })

    it('verifies abort timing of docStoreFastPath (2000ms) and docStoreExtended (8000ms) with fake timers', async () => {
      vi.useFakeTimers()
      try {
        const customRepo = new Repo()
        let callCount = 0
        const abortTimes: number[] = []

        vi.spyOn(customRepo, 'find').mockImplementation((_url, options) => {
          callCount++
          const startTime = Date.now()
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              abortTimes.push(Date.now() - startTime)
              reject(new Error('Aborted'))
            })
          })
        })

        const customStore = new AutomergeDocStore(customRepo)
        const promise = customStore.findHandle('timer-test-item' as ItemId, { knownToExist: true })

        // Fast-path timeout (docStoreFastPath = 2000ms)
        await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.docStoreFastPath)
        // Fast-path aborted, starting extended attempt (callCount = 2)
        expect(callCount).toBe(2)
        expect(abortTimes[0]).toBe(SYNC_TIMEOUTS.docStoreFastPath)

        // Extended timeout (docStoreExtended = 8000ms)
        await vi.advanceTimersByTimeAsync(SYNC_TIMEOUTS.docStoreExtended)
        expect(abortTimes[1]).toBe(SYNC_TIMEOUTS.docStoreExtended)

        const result = await promise
        expect(result).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // =========================================================================
  // 3. hasDataInStorage fallback when no storage checker is available
  // =========================================================================
  describe('hasDataInStorage fallback and storage adapter checking', () => {
    it('uses storageAdapter.has when storageAdapter is configured', async () => {
      const mockAdapter: DocStorageChecker = {
        has: vi.fn().mockResolvedValue(true),
      }
      const store = new AutomergeDocStore(repo, undefined, mockAdapter)
      const result = await store.hasDataInStorage('test-storage-item' as ItemId)

      expect(result).toBe(true)
      expect(mockAdapter.has).toHaveBeenCalledWith([expect.any(String)])
    })

    it('returns false when storageAdapter.has returns false', async () => {
      const mockAdapter: DocStorageChecker = {
        has: vi.fn().mockResolvedValue(false),
      }
      const store = new AutomergeDocStore(repo, undefined, mockAdapter)
      const result = await store.hasDataInStorage('test-storage-item' as ItemId)

      expect(result).toBe(false)
    })

    it('rethrows error when storageAdapter.has rejects', async () => {
      const mockAdapter: DocStorageChecker = {
        has: vi.fn().mockRejectedValue(new Error('Storage disk corruption')),
      }
      const store = new AutomergeDocStore(repo, undefined, mockAdapter)

      await expect(
        store.hasDataInStorage('test-storage-item' as ItemId)
      ).rejects.toThrow('Storage disk corruption')
    })

    it('fallback: returns false when no storageAdapter is configured and repo has no storageSubsystem', async () => {
      const store = new AutomergeDocStore(repo, undefined, null)
      const result = await store.hasDataInStorage('test-item' as ItemId)
      expect(result).toBe(false)

      const docData = await store.loadDocDataFromStorage('test-item' as ItemId)
      expect(docData).toBeUndefined()
    })

    it('fallback: returns true when repo.storageSubsystem returns valid document bytes', async () => {
      const customRepo = new Repo()
      const rawBytes = new Uint8Array([1, 2, 3, 4])
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(rawBytes),
      }
      const store = new AutomergeDocStore(customRepo, undefined, null)

      const exists = await store.hasDataInStorage('test-item' as ItemId)
      expect(exists).toBe(true)

      const loaded = await store.loadDocDataFromStorage('test-item' as ItemId)
      expect(loaded).toEqual(rawBytes)
    })

    it('fallback: returns false when repo.storageSubsystem returns empty bytes or undefined', async () => {
      const customRepo = new Repo()
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockResolvedValue(new Uint8Array(0)),
      }
      const store = new AutomergeDocStore(customRepo, undefined, null)
      expect(await store.hasDataInStorage('test-item' as ItemId)).toBe(false)
      expect(await store.loadDocDataFromStorage('test-item' as ItemId)).toBeUndefined()

      customRepo.storageSubsystem!.loadDocData = vi.fn().mockResolvedValue(undefined)
      expect(await store.hasDataInStorage('test-item' as ItemId)).toBe(false)
      expect(await store.loadDocDataFromStorage('test-item' as ItemId)).toBeUndefined()
    })

    it('fallback: rethrows error when loadDocData in storageSubsystem throws', async () => {
      const customRepo = new Repo()
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = {
        loadDocData: vi.fn().mockRejectedValue(new Error('IndexedDB transaction aborted')),
      }
      const store = new AutomergeDocStore(customRepo, undefined, null)

      await expect(
        store.hasDataInStorage('test-item' as ItemId)
      ).rejects.toThrow('IndexedDB transaction aborted')
      await expect(
        store.loadDocDataFromStorage('test-item' as ItemId)
      ).rejects.toThrow('IndexedDB transaction aborted')
    })

    it('allows dynamic switching between adapter and fallback via setStorageAdapter', async () => {
      const store = new AutomergeDocStore(repo, undefined, null)
      const mockAdapter: DocStorageChecker = {
        has: vi.fn().mockResolvedValue(true),
      }

      store.setStorageAdapter(mockAdapter)
      expect(await store.hasDataInStorage('dyn-item' as ItemId)).toBe(true)
      expect(mockAdapter.has).toHaveBeenCalled()

      store.setStorageAdapter(null)
      expect(await store.hasDataInStorage('dyn-item' as ItemId)).toBe(false)
    })
  })

  // =========================================================================
  // 4. findOrCreateHandle refusing to overwrite existing data
  // =========================================================================
  describe('findOrCreateHandle safety and refusal to overwrite', () => {
    it('returns existing handle directly without creating or importing if already loaded', async () => {
      const itemId = 'already-loaded-item' as ItemId
      const binary = createDocBinary(itemId)
      const existing = await docStore.seedImportedDocument(itemId, binary)

      const deleteSpy = vi.spyOn(repo, 'delete')
      const importSpy = vi.spyOn(repo, 'import')

      const handle = await docStore.findOrCreateHandle(itemId)
      expect(handle).toBe(existing)
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(importSpy).not.toHaveBeenCalled()
    })

    it('refuses to overwrite and returns undefined when options.knownToExist is true but findHandleInternal timed out', async () => {
      const customRepo = new Repo()
      const itemId = 'known-item-timeout' as ItemId
      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))
      const deleteSpy = vi.spyOn(customRepo, 'delete')
      const importSpy = vi.spyOn(customRepo, 'import')

      const customStore = new AutomergeDocStore(customRepo)
      const handle = await customStore.findOrCreateHandle(itemId, { knownToExist: true })

      expect(handle).toBeUndefined()
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(importSpy).not.toHaveBeenCalled()
    })

    it('refuses to overwrite and returns undefined when document exists in storage but findHandleInternal timed out', async () => {
      const customRepo = new Repo()
      const itemId = 'storage-exists-timeout' as ItemId
      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      const customStore = new AutomergeDocStore(customRepo)
      vi.spyOn(customStore, 'hasDataInStorage').mockResolvedValue(true)
      const deleteSpy = vi.spyOn(customRepo, 'delete')
      const importSpy = vi.spyOn(customRepo, 'import')

      const handle = await customStore.findOrCreateHandle(itemId)

      expect(handle).toBeUndefined()
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(importSpy).not.toHaveBeenCalled()
    })

    it('refuses to overwrite and returns undefined when storage check throws an error (e.g. quota/lock contention)', async () => {
      const customRepo = new Repo()
      const itemId = 'storage-check-error' as ItemId
      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Timed out'))

      const customStore = new AutomergeDocStore(customRepo)
      vi.spyOn(customStore, 'hasDataInStorage').mockRejectedValue(new Error('QuotaExceededError'))
      const deleteSpy = vi.spyOn(customRepo, 'delete')
      const importSpy = vi.spyOn(customRepo, 'import')

      const handle = await customStore.findOrCreateHandle(itemId)

      expect(handle).toBeUndefined()
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(importSpy).not.toHaveBeenCalled()
    })

    it('creates and imports fresh document when document genuinely does not exist in storage', async () => {
      const customRepo = new Repo()
      const itemId = 'genuinely-new-item' as ItemId
      const documentId = toDocumentIdFromItemId(itemId)
      const deleteSpy = vi.spyOn(customRepo, 'delete')
      const importSpy = vi.spyOn(customRepo, 'import')

      const customStore = new AutomergeDocStore(customRepo)
      vi.spyOn(customStore, 'hasDataInStorage').mockResolvedValue(false)

      const handle = await customStore.findOrCreateHandle(itemId)

      expect(handle).toBeDefined()
      expect(handle?.isReady()).toBe(true)
      expect(deleteSpy).toHaveBeenCalledWith(documentId)
      expect(importSpy).toHaveBeenCalledWith(expect.any(Uint8Array), { docId: documentId })
    })

    it('notifies onDocHandleReplaced and emits docHandleReplaced on internalEventHub when creating document', async () => {
      const hub = new WorkerInternalEventHub()
      const emitSpy = vi.spyOn(hub, 'emit')
      const listenerSpy = vi.fn()

      const store = new AutomergeDocStore(repo, hub)
      store.onDocHandleReplaced = listenerSpy
      vi.spyOn(store, 'hasDataInStorage').mockResolvedValue(false)

      const itemId = 'event-notify-item' as ItemId
      const handle = await store.findOrCreateHandle(itemId)

      expect(listenerSpy).toHaveBeenCalledWith(itemId, handle)
      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'docHandleReplaced',
        itemId,
        handle,
      }))
    })

    it('throws wrapped error if repo.import fails during creation', async () => {
      const customRepo = new Repo()
      const itemId = 'import-failure-item' as ItemId
      vi.spyOn(customRepo, 'import').mockImplementation(() => {
        throw new Error('WASM out of memory')
      })

      const customStore = new AutomergeDocStore(customRepo)
      vi.spyOn(customStore, 'hasDataInStorage').mockResolvedValue(false)

      await expect(customStore.findOrCreateHandle(itemId)).rejects.toThrow(
        `[AutomergeDocStore] Failed to import/create document for ${itemId}: WASM out of memory`
      )
    })

    it('deduplicates concurrent findOrCreateHandle calls for the same item (findOrCreateGuard)', async () => {
      const itemId = 'concurrent-create-item' as ItemId
      vi.spyOn(docStore, 'hasDataInStorage').mockResolvedValue(false)
      const importSpy = vi.spyOn(repo, 'import')

      const [handleA, handleB] = await Promise.all([
        docStore.findOrCreateHandle(itemId),
        docStore.findOrCreateHandle(itemId),
      ])

      expect(handleA).toBeDefined()
      expect(handleA).toBe(handleB)
      expect(importSpy).toHaveBeenCalledTimes(1)
    })
  })

  // =========================================================================
  // 5. Item lock contention and deadlock-freedom
  // =========================================================================
  describe('Item lock contention and deadlock-freedom', () => {
    it('serializes concurrent withItemLock operations on the same itemId (mutual exclusion)', async () => {
      const itemId = 'mutex-item-1' as ItemId
      const log: string[] = []
      let resolveFirst: () => void

      const op1 = docStore.withItemLock(itemId, async () => {
        log.push('op1:start')
        await new Promise<void>(res => { resolveFirst = res })
        log.push('op1:finish')
        return 'res1'
      })

      const op2 = docStore.withItemLock(itemId, async () => {
        log.push('op2:start')
        log.push('op2:finish')
        return 'res2'
      })

      // Yield microtasks so op1 enters its lock and executes up to the promise
      await new Promise(res => setTimeout(res, 0))

      // op2 must be waiting behind op1
      expect(log).toEqual(['op1:start'])

      resolveFirst!()
      const [r1, r2] = await Promise.all([op1, op2])

      expect(r1).toBe('res1')
      expect(r2).toBe('res2')
      expect(log).toEqual(['op1:start', 'op1:finish', 'op2:start', 'op2:finish'])
    })

    it('allows concurrent execution across different itemIds without head-of-line blocking (deadlock freedom)', async () => {
      const itemA = 'item-A' as ItemId
      const itemB = 'item-B' as ItemId
      const log: string[] = []
      let resolveA: () => void
      let resolveB: () => void

      const opA = docStore.withItemLock(itemA, async () => {
        log.push('A:start')
        await new Promise<void>(res => { resolveA = res })
        log.push('A:finish')
      })

      const opB = docStore.withItemLock(itemB, async () => {
        log.push('B:start')
        await new Promise<void>(res => { resolveB = res })
        log.push('B:finish')
      })

      // Yield microtasks so both locks begin their tasks
      await new Promise(res => setTimeout(res, 0))

      // Both should start concurrently because they have different item IDs
      expect(log).toContain('A:start')
      expect(log).toContain('B:start')

      resolveA!()
      resolveB!()
      await Promise.all([opA, opB])

      expect(log).toContain('A:finish')
      expect(log).toContain('B:finish')
    })

    it('releases lock when an operation throws an error (no deadlock on failure)', async () => {
      const itemId = 'error-lock-item' as ItemId

      await expect(
        docStore.withItemLock(itemId, async () => {
          throw new Error('Lock internal error')
        })
      ).rejects.toThrow('Lock internal error')

      // Subsequent operation on the same item ID must succeed without stalling
      const nextResult = await docStore.withItemLock(itemId, async () => 'recovered')
      expect(nextResult).toBe('recovered')
    })

    it('waitForItemLock resolves immediately when no lock is held and waits when locked', async () => {
      const itemId = 'wait-lock-item' as ItemId

      // When idle, resolves immediately
      await expect(docStore.waitForItemLock(itemId)).resolves.toBeUndefined()

      // When locked, waits for in-flight operation
      let resolveLock: () => void
      const op = docStore.withItemLock(itemId, async () => {
        await new Promise<void>(res => { resolveLock = res })
      })

      // Yield microtasks so op starts and assigns resolveLock
      await new Promise(res => setTimeout(res, 0))

      let waitFinished = false
      const waitPromise = docStore.waitForItemLock(itemId).then(() => {
        waitFinished = true
      })

      expect(waitFinished).toBe(false)
      resolveLock!()
      await Promise.all([op, waitPromise])
      expect(waitFinished).toBe(true)
    })

    it('findHandle coordinates with in-flight findOrCreateGuard promise', async () => {
      const itemId = 'guard-coord-item' as ItemId
      vi.spyOn(docStore, 'hasDataInStorage').mockResolvedValue(false)

      let releaseCreate: () => void
      const createPromise = docStore.findOrCreateHandle(itemId).then(async handle => {
        await new Promise<void>(res => { releaseCreate = res })
        return handle
      })

      // Yield microtasks so findOrCreateHandle starts and sets up the guard promise
      await new Promise(res => setTimeout(res, 0))

      // In parallel, findHandle for the same item should pick up the pending guard promise
      const findPromise = docStore.findHandle(itemId)

      releaseCreate!()
      const [handleCreate, handleFind] = await Promise.all([createPromise, findPromise])

      expect(handleCreate).toBeDefined()
      expect(handleFind).toBe(handleCreate)
    })
  })

  // =========================================================================
  // 6. Additional AutomergeDocStore core methods
  // =========================================================================
  describe('changeDocument, compactDocument, saveDocToStorage, and helpers', () => {
    it('changeDocument returns false for invalid itemId', async () => {
      const res = await docStore.changeDocument('' as ItemId, () => {})
      expect(res).toBe(false)
    })

    it('changeDocument returns false when document handle is missing and createIfMissing is false', async () => {
      vi.spyOn(docStore, 'hasDataInStorage').mockResolvedValue(false)
      const res = await docStore.changeDocument('missing-item' as ItemId, () => {}, { createIfMissing: false })
      expect(res).toBe(false)
    })

    it('changeDocument catches handle.change errors and returns false', async () => {
      const itemId = 'change-error-item' as ItemId
      await docStore.changeDocument(itemId, draft => {
        draft.name = 'Initial'
      }, { createIfMissing: true })

      const handle = await docStore.findHandle(itemId)
      expect(handle).toBeDefined()
      vi.spyOn(handle!, 'change').mockImplementation(() => {
        throw new Error('Change failed')
      })

      const success = await docStore.changeDocument(itemId, draft => {
        draft.name = 'Updated'
      })
      expect(success).toBe(false)
    })

    it('changeDocument successfully applies draft mutations to existing document', async () => {
      const itemId = 'change-success-item' as ItemId
      const initialItem = createTestItem(itemId, { name: 'Initial Name' })
      await docStore.changeDocument(itemId, draft => {
        for (const [k, v] of Object.entries(initialItem)) {
          draft[k] = v
        }
      }, { createIfMissing: true })

      const success = await docStore.changeDocument(itemId, draft => {
        draft.name = 'Mutated Name'
      })
      expect(success).toBe(true)

      const item = await docStore.getAutomergeItem(itemId)
      expect(item?.name).toBe('Mutated Name')
    })

    it('compactDocument returns false for invalid itemId', async () => {
      const res = await docStore.compactDocument('' as ItemId, {} as any)
      expect(res).toBe(false)
    })

    it('compactDocument recreates document with current item state and notifies handle replacement', async () => {
      const itemId = 'compact-target-item' as ItemId
      const listenerSpy = vi.fn()
      docStore.onDocHandleReplaced = listenerSpy

      const item = createTestItem(itemId, { name: 'Compacted Name', description: 'Compacted Desc' })
      const success = await docStore.compactDocument(itemId, item)

      expect(success).toBe(true)
      expect(listenerSpy).toHaveBeenCalledWith(itemId, expect.objectContaining({
        documentId: expect.any(String),
      }))

      const retrieved = await docStore.getAutomergeItem(itemId)
      expect(retrieved?.name).toBe('Compacted Name')
      expect(retrieved?.description).toBe('Compacted Desc')
    })

    it('saveDocToStorage returns false if repo.storageSubsystem is undefined', async () => {
      const saved = await docStore.saveDocToStorage('save-item' as ItemId)
      expect(saved).toBe(false)
    })

    it('saveDocToStorage calls storageSubsystem.saveDoc when handle is ready', async () => {
      const customRepo = new Repo()
      const itemId = 'save-ready-item' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const binary = createDocBinary(itemId)
      const handle = customRepo.import(binary, { docId })

      const saveDocMock = vi.fn().mockResolvedValue(undefined)
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = { saveDoc: saveDocMock }

      const store = new AutomergeDocStore(customRepo)
      const saved = await store.saveDocToStorage(itemId)

      expect(saved).toBe(true)
      expect(saveDocMock).toHaveBeenCalledWith(docId, expect.anything())
    })

    it('saveDocToStorage attempts findHandle with knownToExist: true if handle is not in cache', async () => {
      const customRepo = new Repo()
      const itemId = 'save-find-item' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const binary = createDocBinary(itemId)
      const handle = customRepo.import(binary, { docId })

      const saveDocMock = vi.fn().mockResolvedValue(undefined)
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = { saveDoc: saveDocMock }

      vi.spyOn(customRepo, 'find').mockResolvedValue(handle as any)

      const store = new AutomergeDocStore(customRepo)
      const saved = await store.saveDocToStorage(itemId)

      expect(saved).toBe(true)
      expect(saveDocMock).toHaveBeenCalledWith(docId, expect.anything())
    })

    it('saveDocToStorage returns false if findHandle fails to retrieve document', async () => {
      const customRepo = new Repo()
      // @ts-expect-error mocking storageSubsystem
      customRepo.storageSubsystem = { saveDoc: vi.fn() }
      vi.spyOn(customRepo, 'find').mockRejectedValue(new Error('Not found'))

      const store = new AutomergeDocStore(customRepo)
      const saved = await store.saveDocToStorage('save-fail-item' as ItemId)
      expect(saved).toBe(false)
    })

    it('seedImportedDocument concurrency defense: merges incoming binary if ready handle already exists in repo', async () => {
      const itemId = 'seed-existing-ready' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const baseBinary = createDocBinary(itemId, { name: 'Existing Ready' })
      const existingHandle = repo.import(baseBinary, { docId })

      const remoteDoc = Automerge.change(Automerge.load<Item>(baseBinary), d => {
        d.description = 'Merged Via Seed'
      })
      const remoteBinary = Automerge.save(remoteDoc)

      const returnedHandle = await docStore.seedImportedDocument(itemId, remoteBinary)

      expect(returnedHandle).toBe(existingHandle)
      const item = await docStore.getAutomergeItem(itemId)
      expect(item?.name).toBe('Existing Ready')
      expect(item?.description).toBe('Merged Via Seed')
    })

    it('removeAutomergeItem ignores invalid itemId and cleanly deletes valid document from repo and cache', async () => {
      await expect(docStore.removeAutomergeItem('' as ItemId)).resolves.toBeUndefined()

      const itemId = 'remove-item-target' as ItemId
      const docId = toDocumentIdFromItemId(itemId)
      const binary = createDocBinary(itemId)
      await docStore.seedImportedDocument(itemId, binary)

      const deleteSpy = vi.spyOn(repo, 'delete')
      const removeFromCacheSpy = vi.spyOn(repo, 'removeFromCache')

      await docStore.removeAutomergeItem(itemId)

      expect(deleteSpy).toHaveBeenCalledWith(docId)
      expect(removeFromCacheSpy).toHaveBeenCalledWith(docId)
      expect(await docStore.getAutomergeItem(itemId)).toBeNull()
    })

    it('snapshotFromHandle returns null for missing or non-ready handle or empty doc', () => {
      expect(docStore.snapshotFromHandle(undefined)).toBeNull()

      const mockUnready = { isReady: () => false, doc: () => ({}) } as unknown as DocHandle<RepoDoc>
      expect(docStore.snapshotFromHandle(mockUnready)).toBeNull()
    })

    it('getAutomergeItem returns null for invalid itemId or empty snapshot', async () => {
      expect(await docStore.getAutomergeItem('' as ItemId)).toBeNull()
      expect(await docStore.getAutomergeItem('missing-item' as ItemId)).toBeNull()
    })

    it('implements LifecycleAware: lifecycleName is DocStore and onLifecycleStop delegates to shutdown', async () => {
      expect(docStore.lifecycleName).toBe('DocStore')

      const customRepo = new Repo()
      const shutdownSpy = vi.spyOn(customRepo, 'shutdown').mockResolvedValue(undefined)
      const store = new AutomergeDocStore(customRepo)

      await store.onLifecycleStop()
      expect(shutdownSpy).toHaveBeenCalledTimes(1)
    })

    it('shutdown catches and logs repo shutdown failures without rethrowing', async () => {
      const customRepo = new Repo()
      vi.spyOn(customRepo, 'shutdown').mockRejectedValue(new Error('Shutdown error'))
      const store = new AutomergeDocStore(customRepo)

      await expect(store.shutdown()).resolves.toBeUndefined()
    })

    it('setInternalEventHub allows updating internal event hub', async () => {
      const customHub = new WorkerInternalEventHub()
      const emitSpy = vi.spyOn(customHub, 'emit')
      docStore.setInternalEventHub(customHub)

      const itemId = 'custom-hub-item' as ItemId
      const binary = createDocBinary(itemId)
      await docStore.seedImportedDocument(itemId, binary)

      expect(emitSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'docHandleReplaced',
        itemId,
      }))
    })

    it('exportAllBinaries and restoreFromBinaries correctly roundtrips documents', async () => {
      const accountId = 'test-docstore-backup-account'
      const indexStore = new IndexStore(accountId)
      const indexManager = new AutomergeIndexManager(accountId, indexStore)

      await indexStore.clear()
      await indexManager.ensureIndexDocument()

      const item1 = createTestItem('backup-item-1' as ItemId, { name: 'Item 1' })
      const item2 = createTestItem('backup-item-2' as ItemId, { name: 'Item 2' })

      await docStore.seedImportedDocument(item1.id, createDocBinary(item1.id, item1))
      await docStore.seedImportedDocument(item2.id, createDocBinary(item2.id, item2))
      await indexManager.addAutomergeItemIdsToIndex([item1.id, item2.id])
      await indexManager.updateAutomergeMetadata({ prayerGoal: 42 })

      const exported = await docStore.exportAllBinaries(indexManager)

      expect(exported.skipped).toEqual([])
      expect(exported.documents[item1.id]).toBeDefined()
      expect(exported.documents[item2.id]).toBeDefined()
      expect(exported.documents[ACCOUNT_INDEX_DOCUMENT_ID]).toBeDefined()

      // Reset local documents
      await docStore.removeAutomergeItem(item1.id)
      await docStore.removeAutomergeItem(item2.id)
      await indexStore.clear()
      await indexManager.ensureIndexDocument()

      expect(await docStore.getAutomergeItem(item1.id)).toBeNull()

      // Restore from binaries
      const restoredIds = await docStore.restoreFromBinaries(exported.documents, indexManager)
      expect(restoredIds).toContain(item1.id)
      expect(restoredIds).toContain(item2.id)

      const restoredItem1 = await docStore.getAutomergeItem(item1.id)
      expect(restoredItem1?.name).toBe('Item 1')

      const indexItemIds = await indexManager.listAutomergeItemIds()
      expect(indexItemIds).toContain(item1.id)
      expect(indexItemIds).toContain(item2.id)

      const restoredMeta = await indexManager.getAutomergeMetadata()
      expect(restoredMeta.prayerGoal).toBe(42)

      indexManager.close()
    })

    it('exportAllBinaries tracks skipped items when documents fail to load or have empty doc', async () => {
      const accountId = 'test-docstore-skip-account'
      const indexStore = new IndexStore(accountId)
      const indexManager = new AutomergeIndexManager(accountId, indexStore)
      await indexStore.clear()
      await indexManager.ensureIndexDocument()

      await indexManager.addAutomergeItemIdsToIndex(['missing-item' as ItemId])

      vi.spyOn(docStore, 'findHandle').mockResolvedValue(undefined)

      const exported = await docStore.exportAllBinaries(indexManager)
      expect(exported.skipped).toContain('missing-item')
      expect(exported.documents['missing-item' as BackupDocId]).toBeUndefined()

      indexManager.close()
    })
  })
})

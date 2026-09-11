import { Repo, DocHandle, interpretAsDocumentId, type AutomergeUrl } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { ItemId, ItemIdSchema, standardItemSchema, errorItemSchema, ErrorItem } from '../../../shared/schemas/items'
import type { Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import {
  readObjectSnapshot,
  toAutomergeUrlFromItemId,
  ACCOUNT_INDEX_DOCUMENT_ID,
  areHeadsEqual,
  type BackupDocId,
} from '../utils/automerge'
import { isPlainObject } from '../utils/objectUtils'
import type { AutomergeIndexManager } from './AutomergeIndexManager'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined

export interface HydrateDocumentResult {
  hasLocalChanges: boolean
  incomingHeads: string[]
  isDeleted?: boolean
}

export type ChangeDocumentOptions = {
  createIfMissing?: boolean
  knownToExist?: boolean
}

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: ItemId[]
  tombstoneIds?: ItemId[]
  metadata?: AccountMetadata
  lastSyncTime?: number
  lastManifestSyncTime?: number
}

export function normalizeItemId(raw: unknown): ItemId | null {
  const result = ItemIdSchema.safeParse(raw)
  return result.success ? result.data : null
}

export function normalizeItemSnapshot(itemId: ItemId, snapshot: RepoDoc | null): Item | null {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return null
  }

  const item = snapshot as Partial<Item>
  const normalizedItem = {
    ...(typeof item.id === 'string' && item.id.length > 0
      ? item
      : { ...item, id: itemId }),
    isNew: undefined,
  }

  if (normalizedItem.type !== 'group') {
    delete (normalizedItem as Record<string, unknown>).members
    delete (normalizedItem as Record<string, unknown>).memberPrayerFrequency
    delete (normalizedItem as Record<string, unknown>).memberPrayerTarget
  }

  const parsed = standardItemSchema.safeParse(normalizedItem)
  if (parsed.success) {
    return parsed.data as Item
  }

  const errorParsed = errorItemSchema.safeParse(normalizedItem)
  if (errorParsed.success) {
    return errorParsed.data as Item
  }

  return {
    id: itemId,
    type: 'error',
    name: 'Corrupt Item',
    description: 'This item could not be parsed.',
    created: typeof normalizedItem.created === 'number' ? normalizedItem.created : Date.now(),
    archived: !!normalizedItem.archived,
    prayerFrequency: 'none',
    notes: [],
    prayedFor: [],
    originalType: normalizedItem.type as ErrorItem['originalType'],
    rawSnapshot: snapshot,
  } as Item
}

export type DocHandleReplacedListener = (itemId: ItemId, handle: DocHandle<RepoDoc>) => void

export interface ItemLockCoordinator {
  withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T>
}

export class AutomergeDocStore implements ItemLockCoordinator {
  private pendingFindOrCreate = new Map<ItemId, Promise<RepoDocHandle>>()
  private itemLocks = new Map<ItemId, Promise<unknown>>()
  public onDocHandleReplaced?: DocHandleReplacedListener

  constructor(
    private readonly repo: Repo,
  ) {}

  async withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T> {
    const prevLock = this.itemLocks.get(itemId) ?? Promise.resolve()
    let release: () => void
    const lockPromise = new Promise<void>(resolve => {
      release = resolve
    })
    const nextLock = prevLock.catch(() => {}).then(() => lockPromise)
    this.itemLocks.set(itemId, nextLock)

    try {
      await prevLock.catch(() => {})
      return await fn()
    } finally {
      release!()
      if (this.itemLocks.get(itemId) === nextLock) {
        this.itemLocks.delete(itemId)
      }
    }
  }

  async waitForItemLock(itemId: ItemId): Promise<void> {
    const lock = this.itemLocks.get(itemId)
    if (lock) {
      await lock.catch(() => {})
    }
  }

  private resolveDocumentId(itemId: ItemId) {
    const url = toAutomergeUrlFromItemId(itemId)
    return { url, documentId: interpretAsDocumentId(url) }
  }

  async loadDocDataFromStorage(itemId: ItemId): Promise<Uint8Array | undefined> {
    if (!this.repo.storageSubsystem) return undefined
    const { documentId } = this.resolveDocumentId(itemId)
    try {
      const data = await this.repo.storageSubsystem.loadDocData(documentId)
      return (data && data.length > 0) ? data : undefined
    } catch (error) {
      console.error(`[AutomergeDocStore] Storage error loading document data for ${itemId}:`, error)
      throw error
    }
  }

  async hasDataInStorage(itemId: ItemId): Promise<boolean> {
    const data = await this.loadDocDataFromStorage(itemId)
    return !!data
  }

  async saveDocToStorage(itemId: ItemId): Promise<boolean> {
    if (!this.repo.storageSubsystem) return false
    const { documentId } = this.resolveDocumentId(itemId)
    let handle: RepoDocHandle = this.repo.handles[documentId]
    if (!handle || !handle.isReady()) {
      handle = await this.findHandle(itemId, { knownToExist: true })
    }
    if (!handle || !handle.isReady()) return false
    const doc = handle.doc()
    if (!doc) return false
    await this.repo.storageSubsystem.saveDoc(documentId, doc)
    return true
  }

  private async timedFind(
    url: AutomergeUrl,
    timeoutMs: number,
  ): Promise<RepoDocHandle> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await this.repo.find<RepoDoc>(url, { signal: controller.signal })
    } catch {
      return undefined
    } finally {
      clearTimeout(timeoutId)
    }
  }

  async findHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    const pending = this.pendingFindOrCreate.get(itemId)
    if (pending) {
      return pending
    }
    await this.waitForItemLock(itemId)
    return this.findHandleInternal(itemId, options)
  }

  private async findHandleInternal(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    const { url, documentId } = this.resolveDocumentId(itemId)

    // 1. Check in-memory handles cache first (only if ready)
    let handle: RepoDocHandle = this.repo.handles[documentId]
    if (handle && handle.isReady()) return handle

    // If handle exists in cache but is still loading, bypass storage check
    // since loading has already been initiated.
    let existsInStorage = !!handle
    if (!existsInStorage) {
      // 2. Determine if it's known to exist (or check locally as fallback)
      if (options.knownToExist !== undefined) {
        existsInStorage = options.knownToExist
      } else {
        try {
          existsInStorage = await this.hasDataInStorage(itemId)
        } catch (error) {
          console.warn(`[AutomergeDocStore] Failed to check storage for ${itemId}:`, error)
          existsInStorage = false
        }
      }
    }

    if (!existsInStorage) return undefined

    // 3. Fast-path attempt (2s)
    handle = await this.timedFind(url, 2000)
    if (handle && handle.isReady()) return handle

    // 4. Extended attempt for confirmed-to-exist documents (8s)
    // Check cache in case it became ready after timedFind aborted
    handle = this.repo.handles[documentId]
    if (handle && handle.isReady()) return handle

    console.warn(
      `[AutomergeDocStore] Document ${itemId} exists in storage but fast-path timed out. Retrying with extended timeout.`
    )
    handle = await this.timedFind(url, 8000)

    // Final cache check — strictly require readiness before returning
    const finalHandle = handle ?? this.repo.handles[documentId]
    return (finalHandle && finalHandle.isReady()) ? finalHandle : undefined
  }

  async findOrCreateHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    const pending = this.pendingFindOrCreate.get(itemId)
    if (pending) {
      return pending
    }

    const promise = this.withItemLock(itemId, async () => {
      let handle = await this.findHandleInternal(itemId, options)
      if (handle) return handle

      if (options.knownToExist) {
        console.error(
          `[AutomergeDocStore] Refusing to overwrite existing storage data for ${itemId}. ` +
          `Document is known to exist but handle could not be loaded within the timeout.`
        )
        return undefined
      }

      // SAFETY: Before creating a blank document, independently verify that
      // the item genuinely doesn't exist in storage. If it does, or if storage
      // check fails due to transient/quota/lock error, we must NOT delete it.
      let dataExists = false
      try {
        dataExists = await this.hasDataInStorage(itemId)
      } catch (storageError) {
        console.error(
          `[AutomergeDocStore] Refusing to overwrite storage data for ${itemId}. ` +
          `Storage check failed with an error, cannot confirm document does not exist:`,
          storageError
        )
        return undefined
      }

      if (dataExists) {
        console.error(
          `[AutomergeDocStore] Refusing to overwrite existing storage data for ${itemId}. ` +
          `Document exists in storage but could not be loaded within the timeout.`
        )
        return undefined
      }

      // Document genuinely doesn't exist — safe to create
      const { documentId } = this.resolveDocumentId(itemId)
      try {
        this.repo.delete(documentId)
      } catch (error) {
        console.error('[automerge] failed to clear unavailable handle before import', {
          itemId,
          error,
        })
      }

      const newDoc = Automerge.init()
      const binary = Automerge.save(newDoc)
      try {
        handle = this.repo.import<RepoDoc>(binary, { docId: documentId })
      } catch (error) {
        throw new Error(
          `[AutomergeDocStore] Failed to import/create document for ${itemId}: ${(error as Error).message}`,
          { cause: error },
        )
      }

      this.onDocHandleReplaced?.(itemId, handle)
      return handle
    })

    this.pendingFindOrCreate.set(itemId, promise)

    try {
      return await promise
    } finally {
      this.pendingFindOrCreate.delete(itemId)
    }
  }

  snapshotFromHandle(handle: RepoDocHandle): RepoDoc | null {
    if (!handle) {
      return null
    }
    const snapshot = readObjectSnapshot(handle)
    return (snapshot && isPlainObject(snapshot)) ? snapshot : null
  }

  async readItemSnapshot(itemId: ItemId): Promise<RepoDoc | null> {
    const handle = await this.findHandle(itemId)
    return this.snapshotFromHandle(handle)
  }

  async changeDocument(
    itemId: ItemId,
    change: (draft: RepoDoc) => void,
    options: ChangeDocumentOptions = {},
  ): Promise<boolean> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return false
    }

    const handle = options.createIfMissing
      ? await this.findOrCreateHandle(normalizedItemId, options)
      : await this.findHandle(normalizedItemId, options)

    if (!handle || !handle.isReady()) {
      return false
    }

    try {
      handle.change(change)
      return true
    } catch (error) {
      console.warn(`[AutomergeDocStore] Failed to change document for ${itemId}:`, error)
      return false
    }
  }

  async getAutomergeItem(itemId: ItemId): Promise<Item | null> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return null
    }

    const snapshot = await this.readItemSnapshot(normalizedItemId)
    return normalizeItemSnapshot(normalizedItemId, snapshot)
  }

  async removeAutomergeItem(itemId: ItemId): Promise<void> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return
    }
    return this.withItemLock(normalizedItemId, async () => {
      const { documentId } = this.resolveDocumentId(normalizedItemId)

      try {
        this.repo.delete(documentId)
      } catch {
        // Ignore missing local handles.
      }

      try {
        await this.repo.removeFromCache(documentId)
      } catch {
        // Ignore cache-eviction failures for handles that were never loaded.
      }
    })
  }

  async hydrateAutomergeDocumentBinary(
    itemId: string,
    binary: Uint8Array,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<HydrateDocumentResult> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
      return { hasLocalChanges: false, incomingHeads: [] }
    }

    return this.withItemLock(normalizedItemId, async () => {
      let incomingHeads: string[] = []
      try {
        const incomingDoc = Automerge.load<RepoDoc>(binary)
        incomingHeads = Automerge.getHeads(incomingDoc)
      } catch {
        // Ignore initial parse failure here; it will throw when importing/loading below if corrupt
      }

      try {
        const existingHandle = await this.findHandleInternal(normalizedItemId, options)

        if (existingHandle && existingHandle.isReady()) {
          const incomingHandle = this.repo.import<RepoDoc>(binary)
          try {
            existingHandle.merge(incomingHandle)
          } finally {
            try {
              this.repo.delete(incomingHandle.documentId)
            } catch {
              // Ignore temp handle cleanup failure
            }
          }
          const doc = existingHandle.doc()
          const postMergeHeads = doc ? Automerge.getHeads(doc) : []
          const hasLocalChanges = !areHeadsEqual(postMergeHeads, incomingHeads)
          const isDeleted = (doc as Record<string, unknown> | undefined)?.deleted === true
          return { hasLocalChanges, incomingHeads, ...(isDeleted ? { isDeleted: true } : {}) }
        } else {
          // Document handle was not available or not ready within timeout.
          // Check whether document exists in storage to avoid clobbering local edits.
          let existsInStorage = options.knownToExist
          let localBinary: Uint8Array | undefined

          if (existsInStorage) {
            localBinary = await this.loadDocDataFromStorage(normalizedItemId)
          } else {
            localBinary = await this.loadDocDataFromStorage(normalizedItemId)
            existsInStorage = !!localBinary
          }

          // Concurrency safety check: verify whether handle in repo became ready during async storage I/O
          const { documentId } = this.resolveDocumentId(normalizedItemId)
          const inMemoryHandle = this.repo.handles[documentId]
          if (inMemoryHandle && inMemoryHandle.isReady()) {
            const incomingHandle = this.repo.import<RepoDoc>(binary)
            try {
              inMemoryHandle.merge(incomingHandle)
            } finally {
              try {
                this.repo.delete(incomingHandle.documentId)
              } catch {
                // Ignore temp handle cleanup failure
              }
            }
            const doc = inMemoryHandle.doc()
            const postMergeHeads = doc ? Automerge.getHeads(doc) : []
            const hasLocalChanges = !areHeadsEqual(postMergeHeads, incomingHeads)
            const isDeleted = (doc as Record<string, unknown> | undefined)?.deleted === true
            return { hasLocalChanges, incomingHeads, ...(isDeleted ? { isDeleted: true } : {}) }
          }

          if (existsInStorage) {
            // Document exists locally. Attempt non-destructive CRDT merge using raw storage binary.
            if (localBinary && localBinary.byteLength > 0) {
              try {
                const localDoc = Automerge.load<RepoDoc>(localBinary)
                const incomingDoc = Automerge.load<RepoDoc>(binary)
                const mergedDoc = Automerge.merge(localDoc, incomingDoc)
                const mergedBinary = Automerge.save(mergedDoc)
                await this.seedImportedDocument(normalizedItemId, mergedBinary)
                const postMergeHeads = Automerge.getHeads(mergedDoc)
                const hasLocalChanges = !areHeadsEqual(postMergeHeads, incomingHeads)
                const isDeleted = (mergedDoc as Record<string, unknown> | undefined)?.deleted === true
                return { hasLocalChanges, incomingHeads, ...(isDeleted ? { isDeleted: true } : {}) }
              } catch (mergeError) {
                console.error('[AutomergeDocStore] Non-destructive direct merge failed', {
                  itemId: normalizedItemId,
                  error: mergeError,
                })
              }
            }

            console.error(
              `[AutomergeDocStore] Refusing to overwrite existing storage data for ${normalizedItemId}. ` +
              `Document exists in storage but handle could not be loaded within timeout and fallback merge failed.`
            )
            throw new Error(
              `[AutomergeDocStore] Refusing to overwrite existing storage data for ${normalizedItemId}`
            )
          }

          // Genuinely new document - safe to seed
          const handle = await this.seedImportedDocument(normalizedItemId, binary)
          const doc = handle.doc()
          const isDeleted = (doc as Record<string, unknown> | undefined)?.deleted === true
          return { hasLocalChanges: false, incomingHeads, ...(isDeleted ? { isDeleted: true } : {}) }
        }
      } catch (error) {
        console.error('[automerge] failed to hydrate document', {
          itemId,
          error,
        })
        throw error
      }
    })
  }

  async seedImportedDocument(itemId: ItemId, binary: Uint8Array): Promise<DocHandle<RepoDoc>> {
    const { documentId } = this.resolveDocumentId(itemId)

    // Concurrency defense: If a ready handle already exists in the repo, merge rather than evicting it!
    const existing = this.repo.handles[documentId]
    if (existing && existing.isReady()) {
      const incomingHandle = this.repo.import<RepoDoc>(binary)
      try {
        existing.merge(incomingHandle)
      } finally {
        try {
          this.repo.delete(incomingHandle.documentId)
        } catch {
          // Ignore temp handle cleanup failure
        }
      }
      this.onDocHandleReplaced?.(itemId, existing)
      return existing
    }

    try {
      await this.repo.removeFromCache(documentId)
    } catch {
      // Ignore cache-eviction failures
    }

    const handle = this.repo.import<RepoDoc>(binary, {
      docId: documentId,
    })
    this.onDocHandleReplaced?.(itemId, handle)
    return handle
  }

  async compactDocument(itemId: ItemId, item: Item): Promise<boolean> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return false
    }
    return this.withItemLock(normalizedItemId, async () => {
      const { documentId } = this.resolveDocumentId(normalizedItemId)

      // Create fresh new doc with only current state (0 historical tombstones)
      let newDoc = Automerge.init<RepoDoc>()
      newDoc = Automerge.change(newDoc, doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      })
      const compactedBinary = Automerge.save(newDoc)

      try {
        this.repo.delete(documentId)
      } catch {
        // Ignore
      }
      try {
        await this.repo.removeFromCache(documentId)
      } catch {
        // Ignore
      }

      const handle = this.repo.import<RepoDoc>(compactedBinary, {
        docId: documentId,
      })
      this.onDocHandleReplaced?.(normalizedItemId, handle)
      return true
    })
  }

  async exportAllBinaries(indexManager: AutomergeIndexManager): Promise<{
    documents: Partial<Record<BackupDocId, string>>
    skipped: ItemId[]
  }> {
    const exported: Partial<Record<BackupDocId, string>> = {}
    const skipped: ItemId[] = []

    for (const itemId of await indexManager.listAutomergeItemIds()) {
      const handle = await this.findHandle(itemId, { knownToExist: true })
      if (!handle || !handle.isReady()) {
        console.warn(`[AutomergeDocStore] Skipping item ${itemId}: document could not be loaded in time`)
        skipped.push(itemId)
        continue
      }

      const doc = handle.doc()
      if (!doc) {
        console.warn(`[AutomergeDocStore] Skipping item ${itemId}: document handle doc is empty`)
        skipped.push(itemId)
        continue
      }

      const binary = Automerge.save(doc)
      exported[itemId] = binary.toBase64()
    }

    const indexDoc = await indexManager.getIndexSnapshot()
    const indexBinary = new TextEncoder().encode(JSON.stringify(indexDoc))
    exported[ACCOUNT_INDEX_DOCUMENT_ID] = indexBinary.toBase64()

    return { documents: exported, skipped }
  }

  async restoreFromBinaries(
    items: Partial<Record<BackupDocId, string>>,
    indexManager: AutomergeIndexManager
  ): Promise<ItemId[]> {
    const restoredItemIds: ItemId[] = []

    const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID]
    if (encodedIndex && typeof encodedIndex === 'string') {
      try {
        const indexBinary = Uint8Array.fromBase64(encodedIndex)
        const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
        if (indexDoc && typeof indexDoc === 'object') {
          await indexManager.replaceIndex(indexDoc)
        }
      } catch (err) {
        console.error('[AutomergeDocStore] Failed to restore index metadata from backup', err)
      }
    }

    for (const [itemId, encodedBinary] of Object.entries(items)) {
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
      if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) continue

      const normalizedItemId = normalizeItemId(itemId)
      if (!normalizedItemId) continue

      try {
        await this.hydrateAutomergeDocumentBinary(
          normalizedItemId,
          Uint8Array.fromBase64(encodedBinary)
        )
        restoredItemIds.push(normalizedItemId)
      } catch (err) {
        console.error(`[AutomergeDocStore] Failed to restore document for ${normalizedItemId}`, err)
      }
    }

    await indexManager.addAutomergeItemIdsToIndex(restoredItemIds)
    return restoredItemIds
  }

  async shutdown(): Promise<void> {
    try {
      await this.repo.shutdown()
    } catch (err) {
      console.error('[automergeDocStore] Failed to close repo:', err)
    }
  }
}

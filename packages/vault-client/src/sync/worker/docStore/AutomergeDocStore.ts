import { Repo, DocHandle, interpretAsDocumentId, type AutomergeUrl, type DocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { ItemId, ItemIdSchema } from '@vault/shared'
import type { VaultDoc, VaultMetadata } from '../../shared/types'
import type { DocCodec } from '../domain'
import {
  readObjectSnapshot,
  toAutomergeUrlFromItemId,
  ACCOUNT_INDEX_DOCUMENT_ID,
  areHeadsEqual,
  type BackupDocId,
} from '../utils/automerge'
import { isPlainObject } from '../utils/objectUtils'
import type { AutomergeIndexManager } from './AutomergeIndexManager'
import { findWithTimeout } from './findWithTimeout'
import type { WorkerInternalEventHub } from '../SyncEventHub'
import { KeyedSingleFlightGuard } from '../../utils/SingleFlightGuard'
import { KeyedAsyncMutex } from '../../utils/AsyncMutex'
import { SYNC_TIMEOUTS } from '../../shared/syncConfig'
import type { LifecycleAware } from '../ServiceLifecycleManager'
import { createLogger } from '../../utils/logger'
import { errorMessage } from '../../utils/errorMessage'

const log = createLogger('AutomergeDocStore')

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
  metadata?: VaultMetadata
  lastManifestSyncTime?: number
}

function normalizeItemId(raw: unknown): ItemId | null {
  const result = ItemIdSchema.safeParse(raw)
  return result.success ? result.data : null
}

/**
 * Decodes a document snapshot with the app's codec, filling in a missing `id`.
 * Returns null for empty documents.
 */
export function normalizeItemSnapshot(
  itemId: ItemId,
  snapshot: RepoDoc | null,
  codec: DocCodec,
): VaultDoc | null {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return null
  }

  const hasId = typeof snapshot.id === 'string' && snapshot.id.length > 0
  return codec.decode(itemId, { ...snapshot, id: hasId ? snapshot.id : itemId })
}

export interface ItemLockCoordinator {
  withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T>
}

export interface DocStorageChecker {
  has(key: string[]): Promise<boolean>
}

export interface AutomergeDocStoreOptions {
  repo: Repo
  internalEventHub: WorkerInternalEventHub
  storageAdapter?: DocStorageChecker | null
  codec: DocCodec
  /**
   * Whether a document's sealed local records failed to decrypt. Its handle never finishes loading
   * (automerge-repo leaves it pending when storage throws), so finds give up at once instead of
   * waiting out their timeouts.
   */
  isLocallyUnreadable: (documentId: DocumentId) => boolean
}

export class AutomergeDocStore implements ItemLockCoordinator, LifecycleAware {
  readonly lifecycleName = 'DocStore'
  private findOrCreateGuard = new KeyedSingleFlightGuard<ItemId, RepoDocHandle>()
  private itemMutex = new KeyedAsyncMutex<ItemId>()
  private readonly repo: Repo
  private readonly internalEventHub: WorkerInternalEventHub
  private storageAdapter?: DocStorageChecker | null
  public readonly codec: DocCodec
  private readonly isLocallyUnreadable: (documentId: DocumentId) => boolean

  async onLifecycleStop(_?: { clearLocalData?: boolean }): Promise<void> {
    await this.shutdown()
  }

  constructor(options: AutomergeDocStoreOptions) {
    this.repo = options.repo
    this.internalEventHub = options.internalEventHub
    this.storageAdapter = options.storageAdapter
    this.codec = options.codec
    this.isLocallyUnreadable = options.isLocallyUnreadable
  }

  private notifyDocHandleReplaced(itemId: ItemId, handle: DocHandle<RepoDoc>): void {
    this.internalEventHub.emit({ type: 'docHandleReplaced', itemId, handle })
  }

  async withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T> {
    return this.itemMutex.runExclusive(itemId, fn)
  }

  async waitForItemLock(itemId: ItemId): Promise<void> {
    return this.itemMutex.waitForIdle(itemId)
  }

  private resolveDocumentId(itemId: ItemId) {
    const url = toAutomergeUrlFromItemId(itemId)
    return { url, documentId: interpretAsDocumentId(url) }
  }

  /** The repo's in-memory handle for the document, when it's ready */
  private getReadyHandle(documentId: DocumentId): RepoDocHandle {
    const handle: RepoDocHandle = this.repo.handles[documentId]
    return handle?.isReady() ? handle : undefined
  }

  async loadDocDataFromStorage(itemId: ItemId): Promise<Uint8Array | undefined> {
    if (!this.repo.storageSubsystem) return undefined
    const { documentId } = this.resolveDocumentId(itemId)
    try {
      const data = await this.repo.storageSubsystem.loadDocData(documentId)
      return (data && data.length > 0) ? data : undefined
    } catch (error) {
      log.error(`Storage error loading document data for ${itemId}:`, error)
      throw error
    }
  }

  async hasDataInStorage(itemId: ItemId): Promise<boolean> {
    const { documentId } = this.resolveDocumentId(itemId)
    if (this.storageAdapter) {
      try {
        return await this.storageAdapter.has([documentId])
      } catch (error) {
        log.error(`Storage error checking document existence for ${itemId}:`, error)
        throw error
      }
    }

    const data = await this.loadDocDataFromStorage(itemId)
    return !!data
  }


  async saveDocToStorage(itemId: ItemId): Promise<boolean> {
    if (!this.repo.storageSubsystem) return false
    const { documentId } = this.resolveDocumentId(itemId)
    const handle = this.getReadyHandle(documentId) ?? await this.findHandle(itemId, { knownToExist: true })
    if (!handle?.isReady()) return false
    const doc = handle.doc()
    if (!doc) return false
    await this.repo.storageSubsystem.saveDoc(documentId, doc)
    return true
  }

  private async timedFind(
    url: AutomergeUrl,
    timeoutMs: number,
  ): Promise<RepoDocHandle> {
    const lookup = await findWithTimeout<RepoDoc>(this.repo, url, timeoutMs)
    return lookup.type === 'found' ? lookup.handle : undefined
  }

  async findHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    const pending = this.findOrCreateGuard.getPromise(itemId)
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
    const cachedHandle = this.getReadyHandle(documentId)
    if (cachedHandle) return cachedHandle

    // If handle exists in cache but is still loading, bypass storage check
    // since loading has already been initiated.
    let existsInStorage = !!this.repo.handles[documentId]
    if (!existsInStorage) {
      // 2. Determine if it's known to exist (or check locally as fallback)
      if (options.knownToExist !== undefined) {
        existsInStorage = options.knownToExist
      } else {
        try {
          existsInStorage = await this.hasDataInStorage(itemId)
        } catch (error) {
          log.warn(`Failed to check storage for ${itemId}:`, error)
          existsInStorage = false
        }
      }
    }

    if (!existsInStorage) return undefined
    if (this.isLocallyUnreadable(documentId)) return undefined

    // 3. Fast-path attempt (2s)
    const fastHandle = await this.timedFind(url, SYNC_TIMEOUTS.docStoreFastPath)
    if (fastHandle?.isReady()) return fastHandle
    if (this.isLocallyUnreadable(documentId)) return undefined

    // 4. Extended attempt for confirmed-to-exist documents (8s)
    // Check cache in case it became ready after timedFind aborted
    const lateHandle = this.getReadyHandle(documentId)
    if (lateHandle) return lateHandle

    log.warn(
      `Document ${itemId} exists in storage but fast-path timed out. Retrying with extended timeout.`
    )
    const extendedHandle = await this.timedFind(url, SYNC_TIMEOUTS.docStoreExtended)

    // Final cache check — strictly require readiness before returning
    if (extendedHandle) return extendedHandle.isReady() ? extendedHandle : undefined
    return this.getReadyHandle(documentId)
  }

  async findOrCreateHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    return this.findOrCreateGuard.run(itemId, () =>
      this.withItemLock(itemId, async () => {
        let handle = await this.findHandleInternal(itemId, options)
        if (handle) return handle

        if (options.knownToExist) {
          log.error(
            `Refusing to overwrite existing storage data for ${itemId}. ` +
            `Document is known to exist but handle could not be loaded within the timeout.`
          )
          return undefined
        }

        // SAFETY: Before creating a blank document, independently verify that
        // the item genuinely doesn't exist in storage. If it does, or if storage
        // check fails due to transient/quota/lock error, we must NOT delete it.
        let dataExists: boolean
        try {
          dataExists = await this.hasDataInStorage(itemId)
        } catch (storageError) {
          log.error(
            `Refusing to overwrite storage data for ${itemId}. ` +
            `Storage check failed with an error, cannot confirm document does not exist:`,
            storageError
          )
          return undefined
        }

        if (dataExists) {
          log.error(
            `Refusing to overwrite existing storage data for ${itemId}. ` +
            `Document exists in storage but could not be loaded within the timeout.`
          )
          return undefined
        }

        // Document genuinely doesn't exist — safe to create
        const { documentId } = this.resolveDocumentId(itemId)
        try {
          this.repo.delete(documentId)
        } catch (error) {
          log.error('Failed to clear unavailable handle before import', {
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
            `[AutomergeDocStore] Failed to import/create document for ${itemId}: ${errorMessage(error)}`,
            { cause: error },
          )
        }

        this.notifyDocHandleReplaced(itemId, handle)
        return handle
      })
    )
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

    if (!handle?.isReady()) {
      return false
    }

    try {
      handle.change(change)
      return true
    } catch (error) {
      log.warn(`Failed to change document for ${itemId}:`, error)
      return false
    }
  }

  decodeSnapshot(itemId: ItemId, snapshot: RepoDoc | null): VaultDoc | null {
    return normalizeItemSnapshot(itemId, snapshot, this.codec)
  }

  async getAutomergeItem(itemId: ItemId): Promise<VaultDoc | null> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return null
    }

    const snapshot = await this.readItemSnapshot(normalizedItemId)
    return this.decodeSnapshot(normalizedItemId, snapshot)
  }

  /**
   * Merges a binary into the handle's doc in place. Importing it as a temporary handle would leak a
   * copy into storage: the Repo's throttled save still fires after the temporary doc is deleted.
   */
  private applyMerge(targetHandle: DocHandle<RepoDoc>, binary: Uint8Array): void {
    const incoming = Automerge.load<RepoDoc>(binary)
    targetHandle.update(doc => Automerge.merge(doc, incoming))
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
      let incomingDoc: Automerge.Doc<RepoDoc> | undefined
      let incomingHeads: string[] = []
      try {
        incomingDoc = Automerge.load<RepoDoc>(binary)
        incomingHeads = Automerge.getHeads(incomingDoc)
      } catch {
        // Ignore initial parse failure here; it will throw when importing/loading below if corrupt
      }

      const existingHandle = await this.findHandleInternal(normalizedItemId, options)

      if (existingHandle?.isReady()) {
        this.applyMerge(existingHandle, binary)
        return this.buildHydrateResult(existingHandle.doc(), incomingHeads)
      } else {
        // Document handle was not available or not ready within timeout.
        // Check whether document exists in storage to avoid clobbering local edits.
        const localBinary = await this.loadDocDataFromStorage(normalizedItemId)
        // `knownToExist` only says the item is indexed. Its local copy may have been removed (to
        // replace an unreadable copy from the server, say), so ask storage rather than trusting the
        // hint. A failed check throws, so nothing is seeded unless storage confirms it's absent.
        const existsInStorage = !!localBinary || await this.hasDataInStorage(normalizedItemId)

        // Concurrency safety check: verify whether handle in repo became ready during async storage I/O
        const { documentId } = this.resolveDocumentId(normalizedItemId)
        const inMemoryHandle = this.getReadyHandle(documentId)
        if (inMemoryHandle) {
          this.applyMerge(inMemoryHandle, binary)
          return this.buildHydrateResult(inMemoryHandle.doc(), incomingHeads)
        }

        if (existsInStorage) {
          // Document exists locally. Attempt non-destructive CRDT merge using raw storage binary.
          let mergeFailure: unknown
          if (localBinary && localBinary.byteLength > 0) {
            try {
              const localDoc = Automerge.load<RepoDoc>(localBinary)
              const mergedDoc = Automerge.merge(localDoc, incomingDoc ?? Automerge.load<RepoDoc>(binary))
              const mergedBinary = Automerge.save(mergedDoc)
              await this.seedImportedDocument(normalizedItemId, mergedBinary)
              return this.buildHydrateResult(mergedDoc, incomingHeads)
            } catch (mergeError) {
              mergeFailure = mergeError
            }
          }

          throw new Error(
            `[AutomergeDocStore] Refusing to overwrite existing storage data for ${normalizedItemId}: ` +
            `its handle didn't load in time and the fallback merge failed`,
            { cause: mergeFailure },
          )
        }

        // Genuinely new document - safe to seed
        const handle = await this.seedImportedDocument(normalizedItemId, binary)
        return this.buildHydrateResult(handle.doc(), incomingHeads)
      }
    })
  }

  private buildHydrateResult(
    doc: RepoDoc | undefined,
    incomingHeads: string[],
  ): HydrateDocumentResult {
    const postMergeHeads = doc ? Automerge.getHeads(doc) : []
    return {
      hasLocalChanges: !areHeadsEqual(postMergeHeads, incomingHeads),
      incomingHeads,
      isDeleted: (doc as Record<string, unknown>)?.deleted === true || undefined,
    }
  }

  async seedImportedDocument(itemId: ItemId, binary: Uint8Array): Promise<DocHandle<RepoDoc>> {
    const { documentId } = this.resolveDocumentId(itemId)

    // Concurrency defense: If a ready handle already exists in the repo, merge rather than evicting it!
    const existing = this.getReadyHandle(documentId)
    if (existing) {
      this.applyMerge(existing, binary)
      this.notifyDocHandleReplaced(itemId, existing)
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
    this.notifyDocHandleReplaced(itemId, handle)
    return handle
  }

  async exportAllBinaries(indexManager: AutomergeIndexManager): Promise<{
    documents: Partial<Record<BackupDocId, string>>
    skipped: ItemId[]
  }> {
    const exported: Partial<Record<BackupDocId, string>> = {}
    const skipped: ItemId[] = []

    for (const itemId of await indexManager.listAutomergeItemIds()) {
      const handle = await this.findHandle(itemId, { knownToExist: true })
      if (!handle?.isReady()) {
        log.warn(`Skipping item ${itemId}: document could not be loaded in time`)
        skipped.push(itemId)
        continue
      }

      const doc = handle.doc()
      if (!doc) {
        log.warn(`Skipping item ${itemId}: document handle doc is empty`)
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
    const activeItemIds: ItemId[] = []
    const deletedItemIds: ItemId[] = []

    const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID]
    if (encodedIndex && typeof encodedIndex === 'string') {
      try {
        const indexBinary = Uint8Array.fromBase64(encodedIndex)
        const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
        if (indexDoc && typeof indexDoc === 'object') {
          await indexManager.mergeIndex(indexDoc)
        }
      } catch (err) {
        log.error('Failed to restore index metadata from backup', err)
      }
    }

    for (const [itemId, encodedBinary] of Object.entries(items)) {
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
      if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) continue

      const normalizedItemId = normalizeItemId(itemId)
      if (!normalizedItemId) continue

      try {
        const result = await this.hydrateAutomergeDocumentBinary(
          normalizedItemId,
          Uint8Array.fromBase64(encodedBinary)
        )
        restoredItemIds.push(normalizedItemId)
        // Merged with the local doc, which may have been deleted since the backup
        if (result.isDeleted) {
          deletedItemIds.push(normalizedItemId)
        } else {
          activeItemIds.push(normalizedItemId)
        }
      } catch (err) {
        log.error(`Failed to restore document for ${normalizedItemId}`, err)
      }
    }

    await indexManager.addAutomergeItemIdsToIndex(activeItemIds)
    if (deletedItemIds.length > 0) {
      await indexManager.removeAutomergeItemIdsFromIndex(deletedItemIds)
    }
    return restoredItemIds
  }

  async shutdown(): Promise<void> {
    this.storageAdapter = null
  }
}

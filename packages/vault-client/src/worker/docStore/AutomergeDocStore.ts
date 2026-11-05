import type { Repo, DocHandle, AutomergeUrl, DocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '@vault/shared'
import type { VaultDoc, VaultMetadata } from '../../shared/types'
import type { DocCodec } from '../domain'
import {
  readObjectSnapshot,
  toAutomergeUrlFromItemId,
  toDocumentIdFromItemId,
  areHeadsEqual,
} from '../utils/automerge'
import { isPlainObject } from '../utils/objectUtils'
import { findWithTimeout } from './findWithTimeout'
import { KeyedSingleFlightGuard } from '../../utils/SingleFlightGuard'
import { KeyedAsyncMutex } from '../../utils/AsyncMutex'
import { SYNC_TIMEOUTS } from '../../shared/syncConfig'
import { createLogger } from '../../utils/logger'
import { errorMessage } from '../../utils/errorMessage'
import { checkAlive } from '../../utils/abort'

const log = createLogger('AutomergeDocStore')

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined

export interface HydrateDocumentResult {
  hasLocalChanges: boolean
  incomingHeads: string[]
  isDeleted?: boolean
}

/** The doc's heads either side of applying log changes. `headsBefore` is null when they can't be known. */
export interface AppliedHeads {
  headsBefore: string[] | null
  headsAfter: string[]
}

export type ApplyIncomingResult =
  | { status: 'applied'; addedChanges: boolean }
  /** Nothing was stored for an unloaded doc. A loaded doc keeps the changes in its own queue. */
  | { status: 'missingDeps' }

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
  /** Called when a find or create puts a new handle in place of an item's old one, so its listeners can move */
  onHandleReplaced?: (itemId: ItemId, handle: DocHandle<RepoDoc>) => void
  storageAdapter: DocStorageChecker
  codec: DocCodec
  /** Called when an indexed item turns out to have no local data, which only the server can restore */
  onLocalDataMissing?: (itemId: ItemId) => void
  /**
   * Whether a document's sealed local records failed to decrypt. Its handle never finishes loading
   * (automerge-repo leaves it pending when storage throws), so finds give up at once instead of
   * waiting out their timeouts.
   */
  isLocallyUnreadable: (documentId: DocumentId) => boolean
}

export class AutomergeDocStore implements ItemLockCoordinator {
  private findOrCreateGuard = new KeyedSingleFlightGuard<ItemId, RepoDocHandle>()
  private itemMutex = new KeyedAsyncMutex<ItemId>()
  private isShutdown = false
  public readonly codec: DocCodec

  constructor(private readonly deps: AutomergeDocStoreOptions) {
    this.codec = deps.codec
  }

  async withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T> {
    return this.itemMutex.runExclusive(itemId, fn)
  }

  private async waitForItemLock(itemId: ItemId): Promise<void> {
    return this.itemMutex.waitForIdle(itemId)
  }

  private resolveDocumentId(itemId: ItemId) {
    return { url: toAutomergeUrlFromItemId(itemId), documentId: toDocumentIdFromItemId(itemId) }
  }

  /** The repo's in-memory handle for the document, when it's ready */
  private getReadyHandle(documentId: DocumentId): RepoDocHandle {
    const handle: RepoDocHandle = this.deps.repo.handles[documentId]
    return handle?.isReady() ? handle : undefined
  }

  async loadDocDataFromStorage(itemId: ItemId): Promise<Uint8Array | undefined> {
    if (!this.deps.repo.storageSubsystem) return undefined
    const { documentId } = this.resolveDocumentId(itemId)
    const data = await this.deps.repo.storageSubsystem.loadDocData(documentId)
    return (data && data.length > 0) ? data : undefined
  }

  async hasDataInStorage(itemId: ItemId): Promise<boolean> {
    checkAlive(null, !this.isShutdown, 'Doc store is shut down')
    const { documentId } = this.resolveDocumentId(itemId)
    return this.deps.storageAdapter.has([documentId])
  }

  async saveDocToStorage(itemId: ItemId): Promise<boolean> {
    if (!this.deps.repo.storageSubsystem) return false
    const { documentId } = this.resolveDocumentId(itemId)
    const handle = this.getReadyHandle(documentId) ?? await this.findHandle(itemId, { knownToExist: true })
    if (!handle?.isReady()) return false
    const doc = handle.doc()
    if (!doc) return false
    await this.deps.repo.storageSubsystem.saveDoc(documentId, doc)
    return true
  }

  private async timedFind(
    url: AutomergeUrl,
    timeoutMs: number,
  ): Promise<RepoDocHandle> {
    const lookup = await findWithTimeout<RepoDoc>(this.deps.repo, url, timeoutMs)
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
    let existsInStorage = !!this.deps.repo.handles[documentId]
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
    if (this.deps.isLocallyUnreadable(documentId)) return undefined

    // 3. Fast-path attempt (2s)
    const fastHandle = await this.timedFind(url, SYNC_TIMEOUTS.docStoreFastPath)
    if (fastHandle?.isReady()) return fastHandle
    if (this.deps.isLocallyUnreadable(documentId)) return undefined

    // 4. Extended attempt for confirmed-to-exist documents (8s)
    // Check cache in case it became ready after timedFind aborted
    const lateHandle = this.getReadyHandle(documentId)
    if (lateHandle) return lateHandle

    log.warn(
      `Document ${itemId} exists in storage but fast-path timed out. Retrying with extended timeout.`
    )
    const extendedHandle = await this.timedFind(url, SYNC_TIMEOUTS.docStoreExtended)

    // Final cache check — strictly require readiness before returning
    if (extendedHandle?.isReady()) return extendedHandle
    const readyHandle = this.getReadyHandle(documentId)
    if (!readyHandle) await this.reportIfLocalDataMissing(itemId, options)
    return readyHandle
  }

  /** The Repo has no peer to ask for a doc it can't find, so a known item with no data goes to the server */
  private async reportIfLocalDataMissing(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'>,
  ): Promise<void> {
    if (!options.knownToExist) return
    try {
      if (!await this.hasDataInStorage(itemId)) {
        this.deps.onLocalDataMissing?.(itemId)
      }
    } catch (error) {
      log.warn(`Failed to check storage for ${itemId}:`, error)
    }
  }

  private async findOrCreateHandle(
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
          this.deps.repo.delete(documentId)
        } catch (error) {
          log.error('Failed to clear unavailable handle before import', {
            itemId,
            error,
          })
        }

        const newDoc = Automerge.init()
        const binary = Automerge.save(newDoc)
        try {
          handle = this.deps.repo.import<RepoDoc>(binary, { docId: documentId })
        } catch (error) {
          throw new Error(
            `[AutomergeDocStore] Failed to import/create document for ${itemId}: ${errorMessage(error)}`,
            { cause: error },
          )
        }

        this.deps.onHandleReplaced?.(itemId, handle)
        return handle
      })
    )
  }

  private snapshotFromHandle(handle: RepoDocHandle): RepoDoc | null {
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
    const handle = options.createIfMissing
      ? await this.findOrCreateHandle(itemId, options)
      : await this.findHandle(itemId, options)

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
    const snapshot = await this.readItemSnapshot(itemId)
    return this.decodeSnapshot(itemId, snapshot)
  }

  /**
   * Merges a doc into the handle's doc in place. Importing its binary as a temporary handle would
   * leak a copy into storage: the Repo's throttled save still fires after the temporary doc is deleted.
   */
  private applyMerge(targetHandle: DocHandle<RepoDoc>, incoming: Automerge.Doc<RepoDoc>): void {
    targetHandle.update(doc => Automerge.merge(doc, incoming))
  }

  async hydrateAutomergeDocumentBinary(
    itemId: ItemId,
    binary: Uint8Array,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<HydrateDocumentResult> {
    if (!(binary instanceof Uint8Array) || binary.byteLength === 0) {
      return { hasLocalChanges: false, incomingHeads: [] }
    }

    return this.withItemLock(itemId, () => this.hydrateWithLock(itemId, binary, options))
  }

  private async hydrateWithLock(
    itemId: ItemId,
    binary: Uint8Array,
    options: Pick<ChangeDocumentOptions, 'knownToExist'>,
  ): Promise<HydrateDocumentResult> {
    const incomingDoc = Automerge.load<RepoDoc>(binary)
    const incomingHeads = Automerge.getHeads(incomingDoc)

    const existingHandle = await this.findHandleInternal(itemId, options)
    if (existingHandle?.isReady()) {
      this.applyMerge(existingHandle, incomingDoc)
      return this.buildHydrateResult(existingHandle.doc(), incomingHeads)
    }

    // Document handle was not available or not ready within timeout.
    // Check whether document exists in storage to avoid clobbering local edits.
    const localBinary = await this.loadDocDataFromStorage(itemId)
    // `knownToExist` only says the item is indexed. Its local copy may have been removed (to
    // replace an unreadable copy from the server, say), so ask storage rather than trusting the
    // hint. A failed check throws, so nothing is seeded unless storage confirms it's absent.
    const existsInStorage = !!localBinary || await this.hasDataInStorage(itemId)

    // Concurrency safety check: verify whether handle in repo became ready during async storage I/O
    const { documentId } = this.resolveDocumentId(itemId)
    const inMemoryHandle = this.getReadyHandle(documentId)
    if (inMemoryHandle) {
      this.applyMerge(inMemoryHandle, incomingDoc)
      return this.buildHydrateResult(inMemoryHandle.doc(), incomingHeads)
    }

    if (existsInStorage) {
      // Document exists locally. Attempt non-destructive CRDT merge using raw storage binary.
      let mergeFailure: unknown
      if (localBinary) {
        try {
          const mergedDoc = Automerge.merge(Automerge.load<RepoDoc>(localBinary), incomingDoc)
          await this.seedImportedDocument(itemId, Automerge.save(mergedDoc))
          return this.buildHydrateResult(mergedDoc, incomingHeads)
        } catch (mergeError) {
          mergeFailure = mergeError
        }
      }

      throw new Error(
        `[AutomergeDocStore] Refusing to overwrite existing storage data for ${itemId}: ` +
        `its handle didn't load in time and the fallback merge failed`,
        { cause: mergeFailure },
      )
    }

    // Genuinely new document - safe to seed
    const handle = await this.seedImportedDocument(itemId, binary, incomingDoc)
    return this.buildHydrateResult(handle.doc(), incomingHeads)
  }

  /**
   * Applies a run of Automerge change chunks from the log. `bytes` must have passed decryption:
   * `loadIncremental` applies what it can of damaged bytes rather than throwing. `onApplied` runs in
   * the same synchronous section as the change to a loaded doc, so no edit can land between them.
   */
  async applyIncomingChanges(
    itemId: ItemId,
    bytes: Uint8Array,
    onApplied?: (heads: AppliedHeads) => void,
  ): Promise<ApplyIncomingResult> {
    return this.withItemLock(itemId, async () => {
      const handle = await this.findHandleInternal(itemId)
      if (handle?.isReady()) {
        return this.applyToLoadedDoc(handle, bytes, onApplied)
      }

      // `Automerge.load` throws on a partial incremental, so the changes go through an empty doc
      const incoming = Automerge.loadIncremental(Automerge.init<RepoDoc>(), bytes)
      if (Automerge.getMissingDeps(incoming, []).length > 0) {
        return { status: 'missingDeps' }
      }
      // Merges into any stored data, and refuses to create a doc over it (sync rule 2)
      const hydrated = await this.hydrateWithLock(itemId, Automerge.save(incoming), {})
      onApplied?.({ headsBefore: hydrated.hasLocalChanges ? null : [], headsAfter: hydrated.incomingHeads })
      return { status: 'applied', addedChanges: true }
    })
  }

  private applyToLoadedDoc(
    handle: DocHandle<RepoDoc>,
    bytes: Uint8Array,
    onApplied?: (heads: AppliedHeads) => void,
  ): ApplyIncomingResult {
    let headsBefore: string[] = []
    handle.update(doc => {
      headsBefore = Automerge.getHeads(doc)
      return Automerge.loadIncremental(doc, bytes)
    })
    const doc = handle.doc()
    if (!doc) throw new Error('Document data not available')
    const headsAfter = Automerge.getHeads(doc)
    onApplied?.({ headsBefore, headsAfter })
    return Automerge.getMissingDeps(doc, []).length > 0
      ? { status: 'missingDeps' }
      : { status: 'applied', addedChanges: !areHeadsEqual(headsBefore, headsAfter) }
  }

  /**
   * What the doc has after `serverHeads`, with the heads it was read at. Heads the doc lacks would
   * return its whole history anyway, so they count as empty. Returns null when the doc can't be loaded.
   */
  async readChangesSince(
    itemId: ItemId,
    serverHeads: string[],
  ): Promise<{ changes: Uint8Array[]; heads: string[] } | null> {
    return this.withItemLock(itemId, async () => {
      const handle = await this.findHandleInternal(itemId)
      const doc = handle?.isReady() ? handle.doc() : undefined
      if (!doc) return null
      const heads = Automerge.getHeads(doc)
      if (areHeadsEqual(heads, serverHeads)) return { changes: [], heads }
      const since = Automerge.hasHeads(doc, serverHeads) ? serverHeads : []
      return { changes: Automerge.getChangesSince(doc, since), heads }
    })
  }

  /** Whether a loaded doc has anything after `serverHeads`. A doc that isn't loaded can't have changed. */
  hasChangesSince(itemId: ItemId, serverHeads: string[]): boolean {
    const doc = this.getReadyHandle(this.resolveDocumentId(itemId).documentId)?.doc()
    return doc ? !areHeadsEqual(Automerge.getHeads(doc), serverHeads) : false
  }

  /** The dependencies the doc's queued changes are waiting for. Empty when it can't be loaded. */
  async getMissingDeps(itemId: ItemId): Promise<string[]> {
    return this.withItemLock(itemId, async () => {
      const handle = await this.findHandleInternal(itemId)
      const doc = handle?.isReady() ? handle.doc() : undefined
      return doc ? Automerge.getMissingDeps(doc, []) : []
    })
  }

  /** The heads of the item's doc, or null when it can't be loaded */
  async readHeads(itemId: ItemId): Promise<string[] | null> {
    const handle = await this.findHandle(itemId)
    const doc = handle?.isReady() ? handle.doc() : undefined
    return doc ? Automerge.getHeads(doc) : null
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

  /** `parsed` is `binary` already loaded, when the caller has it */
  async seedImportedDocument(
    itemId: ItemId,
    binary: Uint8Array,
    parsed?: Automerge.Doc<RepoDoc>,
  ): Promise<DocHandle<RepoDoc>> {
    const { documentId } = this.resolveDocumentId(itemId)

    // Concurrency defense: If a ready handle already exists in the repo, merge rather than evicting it!
    const existing = this.getReadyHandle(documentId)
    if (existing) {
      this.applyMerge(existing, parsed ?? Automerge.load<RepoDoc>(binary))
      this.deps.onHandleReplaced?.(itemId, existing)
      return existing
    }

    try {
      await this.deps.repo.removeFromCache(documentId)
    } catch {
      // Ignore cache-eviction failures
    }

    const handle = this.deps.repo.import<RepoDoc>(binary, {
      docId: documentId,
    })
    this.deps.onHandleReplaced?.(itemId, handle)
    return handle
  }

  shutdown(): void {
    this.isShutdown = true
  }
}

import { Repo, DocHandle, interpretAsDocumentId, type AutomergeUrl } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { ItemId, ItemIdSchema, standardItemSchema, errorItemSchema, ErrorItem } from '../../../shared/schemas/items'
import type { Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { readObjectSnapshot, toAutomergeUrlFromItemId } from '../utils/automerge'
import { isPlainObject } from '../utils/objectUtils'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined

export type ChangeDocumentOptions = {
  createIfMissing?: boolean
  knownToExist?: boolean
}

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: ItemId[]
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

export class AutomergeDocStore {
  private pendingFindOrCreate = new Map<ItemId, Promise<RepoDocHandle>>()

  constructor(
    private readonly repo: Repo,
  ) {}

  private resolveDocumentId(itemId: ItemId) {
    const url = toAutomergeUrlFromItemId(itemId)
    return { url, documentId: interpretAsDocumentId(url) }
  }

  private async hasDataInStorage(itemId: ItemId): Promise<boolean> {
    if (!this.repo.storageSubsystem) return false
    const { documentId } = this.resolveDocumentId(itemId)
    try {
      const data = await this.repo.storageSubsystem.loadDocData(documentId)
      return !!(data && data.length > 0)
    } catch {
      return false
    }
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
        existsInStorage = await this.hasDataInStorage(itemId)
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

    const promise = (async () => {
      let handle = await this.findHandleInternal(itemId, options)
      if (handle) return handle

      // SAFETY: Before creating a blank document, independently verify that
      // the item genuinely doesn't exist in storage. If it does, we must NOT
      // delete it — the load just timed out or hit a transient error.
      const dataExists = await this.hasDataInStorage(itemId)
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

      return handle
    })()

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
  }

  async hydrateAutomergeDocumentBinary(
    itemId: string,
    binary: Uint8Array,
  ): Promise<void> {
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
      return
    }

    try {
      await this.seedImportedDocument(normalizedItemId, binary)
    } catch (error) {
      console.error('[automerge] failed to hydrate document', {
        itemId,
        error,
      })
      return
    }
  }

  async seedImportedDocument(itemId: ItemId, binary: Uint8Array): Promise<void> {
    const { documentId } = this.resolveDocumentId(itemId)

    try {
      await this.repo.removeFromCache(documentId)
    } catch {
      // Ignore cache-eviction failures
    }

    this.repo.import<RepoDoc>(binary, {
      docId: documentId,
    })
  }

  async shutdown(): Promise<void> {
    try {
      await this.repo.shutdown()
    } catch (err) {
      console.error('[automergeDocStore] Failed to close repo:', err)
    }
  }
}

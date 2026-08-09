import { Repo, DocHandle, interpretAsDocumentId } from '@automerge/automerge-repo/slim'
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
  lastModified?: Record<ItemId, number>
  lastSyncTime?: number
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
  constructor(
    private readonly repo: Repo,
  ) {}

  private resolveDocumentId(itemId: ItemId) {
    const url = toAutomergeUrlFromItemId(itemId)
    return { url, documentId: interpretAsDocumentId(url) }
  }

  // Core Document Helpers
  async findHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    const { url, documentId } = this.resolveDocumentId(itemId)

    // 1. Check in-memory handles cache first
    let handle: RepoDocHandle = this.repo.handles[documentId]

    // 2. Determine if it's known to exist (or check locally as fallback)
    let shouldFind = false
    if (options.knownToExist !== undefined) {
      shouldFind = options.knownToExist
    } else {
      // Fall back to checking storage subsystem existence
      if (this.repo.storageSubsystem) {
        try {
          const data = await this.repo.storageSubsystem.loadDocData(documentId)
          shouldFind = !!(data && data.length > 0)
        } catch (_) {
          shouldFind = false
        }
      }
    }

    // 3. Query the repository if the document is known to exist
    if (!handle && shouldFind) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 2000) // 2s safety timeout
      try {
        handle = await this.repo.find<RepoDoc>(url, { signal: controller.signal })
      } catch (error) {
        console.warn(`[AutomergeDocStore] Failed to find document for ${itemId}:`, error)
      } finally {
        clearTimeout(timeoutId)
      }
    }

    return handle
  }

  async findOrCreateHandle(
    itemId: ItemId,
    options: Pick<ChangeDocumentOptions, 'knownToExist'> = {},
  ): Promise<RepoDocHandle> {
    let handle = await this.findHandle(itemId, options)

    if (!handle) {
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
    }

    return handle
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

    handle.change(change)
    return true
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

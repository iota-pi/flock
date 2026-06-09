import { Repo, DocHandle, interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { ItemId, ItemIdSchema, readItemSchema, errorItemSchema, ErrorItem } from '../../../shared/schemas/items'
import type { Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { readObjectSnapshot, toAutomergeUrlFromItemId } from '../utils/automerge'
import { isPlainObject } from '../utils/objectUtils'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined

export type EnsureHandleOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

export type ChangeDocumentOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: ItemId[]
  metadata?: AccountMetadata
  lastModified?: Record<ItemId, number>
}

function normalizeItemId(raw: unknown): ItemId | null {
  const result = ItemIdSchema.safeParse(raw)
  return result.success ? result.data : null
}

export function normalizeItemSnapshot(itemId: ItemId, snapshot: RepoDoc | null): Item | null {
  if (!snapshot || Object.keys(snapshot).length === 0) {
    return null
  }

  const item = snapshot as Partial<Item>
  const normalizedItem = (typeof item.id === 'string' && item.id.length > 0)
    ? item
    : { ...item, id: itemId }

  const parsed = readItemSchema.safeParse(normalizedItem)
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
  private isInitialized = false

  constructor(
    private readonly accountId: string,
    private readonly repo: Repo,
  ) {}

  async initialize(): Promise<void> {
    this.isInitialized = true
  }

  // Core Document Helpers
  async getRepoHandle(itemId: ItemId): Promise<RepoDocHandle> {
    const documentUrl = toAutomergeUrlFromItemId(itemId)
    return this.repo.find<RepoDoc>(documentUrl).catch(() => undefined)
  }

  async ensureDocumentHandle(
    itemId: ItemId,
    options: EnsureHandleOptions = {},
  ): Promise<RepoDocHandle> {
    const documentUrl = toAutomergeUrlFromItemId(itemId)
    const resolvedDocumentId = interpretAsDocumentId(documentUrl)

    let handle = await this.repo.find<RepoDoc>(documentUrl).catch(() => undefined)

    if (!handle && options.createIfMissing) {
      try {
        this.repo.delete(resolvedDocumentId)
      } catch (error) {
        console.error('[automerge] failed to clear unavailable handle before import', {
          itemId,
          error,
        })
      }

      const initialValue = options.initialValue!

      const newDoc = Automerge.from(initialValue)
      const binary = Automerge.save(newDoc)
      try {
        handle = this.repo.import<RepoDoc>(binary, { docId: resolvedDocumentId })
      } catch (error) {
        console.error('[automerge] failed to import document', {
          itemId,
          error,
        })
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
    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      return null
    }

    const handle = await this.getRepoHandle(normalizedItemId)
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

    const handle = await this.ensureDocumentHandle(
      normalizedItemId,
      {
        createIfMissing: options.createIfMissing,
        initialValue: options.initialValue,
      }
    )

    if (!handle || !handle.isReady()) {
      return false
    }

    handle.change(change)
    return true
  }

  async withAutomergeDocumentChange(
    itemId: ItemId,
    change: (draft: RepoDoc) => void,
    options: ChangeDocumentOptions = {},
  ): Promise<boolean> {
    const normalizedDocumentId = normalizeItemId(itemId)
    if (!normalizedDocumentId) {
      return false
    }

    return this.changeDocument(
      normalizedDocumentId,
      change,
      {
        createIfMissing: options.createIfMissing,
        initialValue: options.initialValue,
      }
    )
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

    const documentUrl = toAutomergeUrlFromItemId(normalizedItemId)

    try {
      this.repo.delete(documentUrl)
    } catch {
      // Ignore missing local handles.
    }

    try {
      await this.repo.removeFromCache(interpretAsDocumentId(documentUrl))
    } catch {
      // Ignore cache-eviction failures for handles that were never loaded.
    }
  }

  normalizeItemId(raw: unknown): ItemId | null {
    return normalizeItemId(raw)
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
    const documentUrl = toAutomergeUrlFromItemId(itemId)
    const resolvedDocumentId = interpretAsDocumentId(documentUrl)

    try {
      await this.repo.removeFromCache(resolvedDocumentId)
    } catch {
      // Ignore cache-eviction failures
    }

    this.repo.import<RepoDoc>(binary, {
      docId: resolvedDocumentId,
    })
  }

  async clear(itemIds: ItemId[]): Promise<void> {
    for (const itemId of itemIds) {
      const documentUrl = toAutomergeUrlFromItemId(itemId)
      try {
        this.repo.delete(documentUrl)
      } catch {
        // Ignore missing local handles.
      }
      try {
        await this.repo.removeFromCache(interpretAsDocumentId(documentUrl))
      } catch {
        // Ignore cache-eviction failures for handles that were never loaded.
      }
    }

    this.isInitialized = false

    try {
      await this.repo.shutdown()
    } catch (err) {
      console.error('[automergeDocStore] Failed to close repo before database deletion:', err)
    }
  }
}

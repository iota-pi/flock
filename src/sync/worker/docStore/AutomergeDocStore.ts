import { Repo, DocHandle, interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import localforage from 'localforage'
import { z } from 'zod'
import { ItemId, ItemIdSchema, readItemSchema, errorItemSchema, ErrorItem } from '../../../shared/schemas/items'
import type { Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { getAutomergeDBName } from '../automergeRepo'
import { readObjectSnapshot } from '../automergeHandleUtils'
import { isPlainObject } from '../utils/objectUtils'
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../utils/base64Utils'
import { useSyncStore } from '../../../state/syncStore'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'

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

export function normalizeItemId(raw: unknown): ItemId | null {
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
  private readonly indexStore: LocalForage

  constructor(
    private readonly accountId: string,
    private readonly repo: Repo,
  ) {
    this.indexStore = localforage.createInstance({
      name: 'flock-item-metadata',
      storeName: `index-${this.accountId}`,
    })
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }
    await this.ensureIndexDocument()
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

  // Item Helpers
  async withAutomergeDocumentChange(
    itemId: ItemId,
    change: (draft: RepoDoc) => void,
    options: ChangeDocumentOptions = {},
  ): Promise<boolean> {
    const normalizedDocumentId = normalizeItemId(itemId)
    if (!normalizedDocumentId) {
      return false
    }

    await this.addAutomergeItemIdsToIndex([normalizedDocumentId])

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

    await this.removeAutomergeItemIdsFromIndex([normalizedItemId])

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

  // Index Manager Helpers
  async getIndexSnapshot(): Promise<AutomergeIndexDocument> {
    const doc = await this.indexStore.getItem<AutomergeIndexDocument>('indexDoc')
    return {
      accountId: doc?.accountId || this.accountId,
      itemIds: doc?.itemIds || [],
      metadata: doc?.metadata || {},
      lastModified: doc?.lastModified || {},
    }
  }

  async ensureIndexDocument(): Promise<void> {
    const doc = await this.getIndexSnapshot()
    if (!doc.accountId) {
      doc.accountId = this.accountId
      await this.indexStore.setItem('indexDoc', doc)
    }
  }

  async addAutomergeItemIdsToIndex(itemIds: ItemId[]): Promise<void> {
    const doc = await this.getIndexSnapshot()
    const current = new Set(doc.itemIds)
    let updated = false
    for (const itemId of itemIds) {
      if (!current.has(itemId)) {
        doc.itemIds!.push(itemId)
        current.add(itemId)
        updated = true
      }
    }
    if (updated) {
      await this.indexStore.setItem('indexDoc', doc)
    }
  }

  async removeAutomergeItemIdsFromIndex(itemIds: ItemId[]): Promise<void> {
    const doc = await this.getIndexSnapshot()
    const removeSet = new Set(itemIds)
    const newItemIds = doc.itemIds?.filter(id => !removeSet.has(id)) || []
    const lastModified = doc.lastModified || {}

    for (const id of removeSet) {
      delete lastModified[id]
    }

    doc.itemIds = newItemIds
    doc.lastModified = lastModified
    await this.indexStore.setItem('indexDoc', doc)
  }

  async listAutomergeItemIds(): Promise<ItemId[]> {
    const index = await this.getIndexSnapshot()
    return index.itemIds || []
  }

  async getAutomergeMetadata(): Promise<AccountMetadata> {
    const index = await this.getIndexSnapshot()
    return index.metadata || {}
  }

  async updateLocalMetadata(metadata: AccountMetadata): Promise<void> {
    const doc = await this.getIndexSnapshot()
    doc.metadata = metadata
    await this.indexStore.setItem('indexDoc', doc)
  }

  async updateAutomergeMetadata(changes: Partial<AccountMetadata>): Promise<AccountMetadata> {
    const doc = await this.getIndexSnapshot()
    doc.metadata = { ...doc.metadata, ...changes }
    await this.indexStore.setItem('indexDoc', doc)
    return doc.metadata || {}
  }

  async restoreIndexSnapshot(snapshot: AutomergeIndexDocument): Promise<void> {
    await this.indexStore.setItem('indexDoc', snapshot)
  }

  async updateLocalLastModified(lastModified: Record<ItemId, number>): Promise<void> {
    const doc = await this.getIndexSnapshot()
    doc.lastModified = { ...doc.lastModified, ...lastModified }
    await this.indexStore.setItem('indexDoc', doc)
  }

  // Backup Helpers
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

    await this.addAutomergeItemIdsToIndex([normalizedItemId])
  }

  async exportAllBinaries(): Promise<Partial<Record<ItemId, string>>> {
    const exported: Partial<Record<ItemId, string>> = {}

    // 1. Export Automerge items
    for (const itemId of await this.listAutomergeItemIds()) {
      const handle = await this.ensureDocumentHandle(itemId)
      if (!handle || !handle.isReady()) {
        continue
      }

      const doc = handle.doc()
      if (!doc) {
        continue
      }

      const binary = Automerge.save(doc)
      exported[itemId] = encodeBytesToBase64(binary)
    }

    // 2. Export native index metadata
    const indexDoc = await this.getIndexSnapshot()
    const indexBinary = new TextEncoder().encode(JSON.stringify(indexDoc))
    const indexId = ACCOUNT_INDEX_DOCUMENT_ID as unknown as ItemId
    exported[indexId] = encodeBytesToBase64(indexBinary)

    return exported
  }

  async restoreFromBinaries(items: Partial<Record<ItemId, string>>): Promise<ItemId[]> {
    const restoredItemIds: ItemId[] = []

    // 1. Intercept and restore the native index/metadata first if present
    const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID as unknown as ItemId]
    if (encodedIndex && typeof encodedIndex === 'string') {
      try {
        const indexBinary = decodeBase64ToBytes(encodedIndex)
        const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
        if (indexDoc && typeof indexDoc === 'object') {
          await this.restoreIndexSnapshot(indexDoc)
        }
      } catch (err) {
        console.error('[backup] Failed to restore native index metadata from backup', err)
      }
    }

    // 2. Restore individual Automerge item documents
    for (const [itemId, encodedBinary] of Object.entries(items)) {
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) {
        continue
      }

      if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) {
        continue
      }

      const normalizedItemId = normalizeItemId(itemId)
      if (!normalizedItemId) {
        continue
      }
      await this.hydrateAutomergeDocumentBinary(
        normalizedItemId,
        decodeBase64ToBytes(encodedBinary),
      )

      restoredItemIds.push(normalizedItemId)
    }

    await this.addAutomergeItemIdsToIndex(restoredItemIds)

    useSyncStore.getState().incrementGeneration()

    return restoredItemIds
  }

  async clear(): Promise<void> {
    const itemIds = await this.listAutomergeItemIds()

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

    try {
      await this.indexStore.clear()
    } catch (error) {
      console.error('[automergeDocStore] failed to clear indexStore:', error)
    }

    try {
      const dbName = getAutomergeDBName(this.accountId)
      await localforage.dropInstance({ name: dbName })
    } catch (error) {
      console.error('[automergeDocStore] failed to delete indexedDB database:', error)
    }
  }
}

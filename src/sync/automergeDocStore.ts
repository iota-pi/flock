import type { Item } from '../state/items'
import * as Sentry from '@sentry/react'
import { ERROR_ITEM_TYPE, ITEM_TYPES, supplyMissingAttributes } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import type { ItemId, ItemType } from '../shared/itemTypes'
import {
  clearPersistedAutomergeDocs,
} from './automergeDocStorage'
import { createAutomergeReactivity } from './automergeReactivity'
import {
  initializeAutomergeOrchestratorState,
  persistAutomergeEntry,
  refreshDocumentFromStorage as refreshDocumentFromStorageOrchestrator,
  removePersistedAutomergeEntry,
} from './automergeOrchestrator'
import {
  normalizeForAutomerge,
  normalizeWorkerDocumentPatches,
} from './automergeUtils'
import { setCachedAutomergeBinary } from './automergeBinaryCache'
import {
  applyAutomergeWorkerPatches,
  commitAutomergeWorkerSyncState,
  createAutomergeWorkerSyncMessage,
  exportAutomergeWorkerBinaries,
  receiveAutomergeWorkerSyncMessage,
  removeAutomergeWorkerDocument,
  resetAutomergeDocWorker,
  setAutomergeWorkerRehydrateProvider,
  setAutomergeWorkerBinary,
  setAutomergeWorkerCursor,
  setAutomergeWorkerSnapshot,
  type WorkerDocumentPatch,
  type WorkerRehydrateRecord,
  type WorkerEntrySnapshot,
  type WorkerSerializedEntry,
} from '../workers/automergeDocWorkerManager'

export const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

export type SyncStateToken = Uint8Array
export type AutomergeDocumentPatch = WorkerDocumentPatch

type DocEntry = {
  syncState: SyncStateToken
  cursor: number
  hasLocalChanges: boolean
}

let loadedAccount: string | null = null
const entriesByDocumentId = new Map<string, DocEntry>()
let cachedItemSnapshotById = new Map<string, Item>()
let cachedMetadataSnapshot: AccountMetadata = {}
const cachedSerializedByDocumentId = new Map<string, WorkerSerializedEntry>()

type MemoizedMapProjection<T> = {
  mapRef: Map<string, Item> | null
  size: number
  value: T
}

const memoizedItemsProjection: MemoizedMapProjection<Item[]> = {
  mapRef: null,
  size: -1,
  value: [],
}

const memoizedItemIdsProjection: MemoizedMapProjection<string[]> = {
  mapRef: null,
  size: -1,
  value: [],
}

const reactivity = createAutomergeReactivity()

function memoizeMapValues(map: Map<string, Item>): Item[] {
  if (memoizedItemsProjection.mapRef === map && memoizedItemsProjection.size === map.size) {
    return memoizedItemsProjection.value
  }

  const values = Array.from(map.values())
  memoizedItemsProjection.mapRef = map
  memoizedItemsProjection.size = map.size
  memoizedItemsProjection.value = values
  return values
}

function memoizeMapKeys(map: Map<string, Item>): string[] {
  if (memoizedItemIdsProjection.mapRef === map && memoizedItemIdsProjection.size === map.size) {
    return memoizedItemIdsProjection.value
  }

  const keys = Array.from(map.keys())
  memoizedItemIdsProjection.mapRef = map
  memoizedItemIdsProjection.size = map.size
  memoizedItemIdsProjection.value = keys
  return keys
}

function getRehydrateCacheRecords(): WorkerRehydrateRecord[] {
  const records: WorkerRehydrateRecord[] = []

  for (const [documentId, entry] of entriesByDocumentId) {
    if (!entry.hasLocalChanges) {
      continue
    }

    const serialized = cachedSerializedByDocumentId.get(documentId)
    if (!serialized) {
      continue
    }

    records.push({
      hasLocalChanges: true,
      record: {
        itemId: documentId,
        doc: new Uint8Array(serialized.doc),
        syncState: new Uint8Array(serialized.syncState),
        cursor: entry.cursor,
      },
    })
  }

  return records
}

setAutomergeWorkerRehydrateProvider(() => getRehydrateCacheRecords())

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function isMetadataDocumentId(documentId: string): boolean {
  return documentId === ACCOUNT_METADATA_DOCUMENT_ID
}

function setCachedItemSnapshot(documentId: string, item: Item): void {
  const next = new Map(cachedItemSnapshotById)
  next.set(documentId, item)
  cachedItemSnapshotById = next
}

function removeCachedItemSnapshot(documentId: string): void {
  if (!cachedItemSnapshotById.has(documentId)) {
    return
  }

  const next = new Map(cachedItemSnapshotById)
  next.delete(documentId)
  cachedItemSnapshotById = next
}

function clearCachedItemSnapshots(): void {
  cachedItemSnapshotById = new Map()
}

function inferOriginalType(snapshot: Record<string, unknown>): ItemType | undefined {
  if (typeof snapshot.type !== 'string') {
    return undefined
  }

  return (ITEM_TYPES as readonly string[]).includes(snapshot.type)
    ? snapshot.type as ItemType
    : undefined
}

function createErrorItem(
  itemId: string,
  snapshot: Record<string, unknown>,
  error: unknown,
): Item {
  return {
    archived: typeof snapshot.archived === 'boolean' ? snapshot.archived : false,
    created: typeof snapshot.created === 'number' ? snapshot.created : Date.now(),
    deleted: typeof snapshot.deleted === 'boolean' ? snapshot.deleted : undefined,
    description: 'Item unavailable due to data error. Use hard-delete to remove it from local storage.',
    id: itemId,
    name: typeof snapshot.name === 'string' && snapshot.name.trim().length > 0
      ? snapshot.name
      : 'Item unavailable due to data error',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
    rawSnapshot: normalizeForAutomerge(snapshot),
    errorMessage: error instanceof Error ? error.message : String(error),
    originalType: inferOriginalType(snapshot),
    type: ERROR_ITEM_TYPE,
  }
}

function materializeItem(itemId: string, snapshot: Record<string, unknown>): Item {
  const candidate = {
    ...snapshot,
  }

  if (typeof candidate.id !== 'string') {
    candidate.id = itemId
  }

  if (typeof candidate.type !== 'string' || !(ITEM_TYPES as readonly string[]).includes(candidate.type)) {
    return createErrorItem(itemId, snapshot, new Error('Unsupported or missing item type'))
  }

  try {
    return supplyMissingAttributes(candidate as unknown as Item)
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: 'automerge-doc-store',
        stage: 'materialize-item',
      },
      extra: {
        itemId,
      },
    })
    return createErrorItem(itemId, snapshot, error)
  }
}


function setCachedItemFromSnapshot(documentId: string, snapshot: Record<string, unknown>): void {
  const item = materializeItem(documentId, snapshot)
  if (item.deleted === true) {
    removeCachedItemSnapshot(documentId)
    return
  }

  setCachedItemSnapshot(documentId, item)
}

function applyWorkerEntry(entry: WorkerEntrySnapshot, options?: { hasLocalChanges?: boolean }): void {
  const existing = entriesByDocumentId.get(entry.documentId)
  entriesByDocumentId.set(entry.documentId, {
    cursor: entry.serialized.cursor,
    syncState: entry.serialized.syncState,
    hasLocalChanges: options?.hasLocalChanges ?? existing?.hasLocalChanges ?? false,
  })

  cachedSerializedByDocumentId.set(entry.documentId, {
    doc: new Uint8Array(entry.serialized.doc),
    syncState: new Uint8Array(entry.serialized.syncState),
    cursor: entry.serialized.cursor,
  })

  if (isMetadataDocumentId(entry.documentId)) {
    const normalized = {
      ...entry.snapshot,
    }
    delete normalized.id
    cachedMetadataSnapshot = normalized as AccountMetadata
    return
  }

  setCachedItemFromSnapshot(entry.documentId, entry.snapshot)
}

function notifyAllItemListeners(): void {
  reactivity.notifyAllItemListeners()
}

function notifyItemListeners(itemIds: string[]): void {
  reactivity.notifyItemListeners(itemIds)
}

function notifyMetadataListeners(): void {
  reactivity.notifyMetadataListeners()
}

async function removeDocumentState(documentId: string): Promise<void> {
  entriesByDocumentId.delete(documentId)
  cachedSerializedByDocumentId.delete(documentId)

  if (isMetadataDocumentId(documentId)) {
    cachedMetadataSnapshot = {}
  } else {
    removeCachedItemSnapshot(documentId)
  }

  try {
    await removeAutomergeWorkerDocument(documentId)
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: 'automerge-doc-store',
        stage: 'remove-document-state',
      },
      extra: {
        documentId,
      },
    })
  }
}

function notifyChange(documentId: string): void {
  if (isMetadataDocumentId(documentId)) {
    notifyMetadataListeners()
    return
  }

  notifyItemListeners([documentId])
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  if (loadedAccount === account) {
    return
  }

  loadedAccount = null
  entriesByDocumentId.clear()
  clearCachedItemSnapshots()
  cachedSerializedByDocumentId.clear()
  cachedMetadataSnapshot = {}

  await initializeAutomergeOrchestratorState({
    account,
    applyWorkerEntry,
  })

  loadedAccount = account

  notifyAllItemListeners()
  notifyMetadataListeners()
}

export function listAutomergeDocumentIds(): string[] {
  return Array.from(entriesByDocumentId.keys())
}

export function filterAutomergeLocallyChangedDocumentIds(itemIds: string[]): string[] {
  const filtered: string[] = []
  const seen = new Set<string>()

  for (const itemId of itemIds) {
    if (seen.has(itemId)) {
      continue
    }

    seen.add(itemId)

    if (entriesByDocumentId.get(itemId)?.hasLocalChanges === true) {
      filtered.push(itemId)
    }
  }

  return filtered
}

export function hasAutomergeDocument(documentId: string): boolean {
  return entriesByDocumentId.has(documentId)
}

export function listAutomergeItemIds(): string[] {
  return listAutomergeDocumentIds().filter(documentId => !isMetadataDocumentId(documentId))
}

async function refreshDocumentFromStorage(documentId: string): Promise<void> {
  try {
    await refreshDocumentFromStorageOrchestrator({
      documentId,
      loadedAccount,
      hasLocalChanges: (targetDocumentId: string) => entriesByDocumentId.get(targetDocumentId)?.hasLocalChanges === true,
      applyWorkerEntry,
      persistEntry: persistAutomergeEntry,
      removeDocumentState,
    })
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: 'automerge-doc-store',
        stage: 'refresh-document-from-storage',
      },
      extra: {
        documentId,
      },
    })

    await removeDocumentState(documentId)
  }
}

export function invalidateCachedItems(itemIds: string[]): void {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => typeof itemId === 'string' && itemId.length > 0)))
  if (uniqueItemIds.length === 0) {
    return
  }

  const staleItemIds = uniqueItemIds.filter(itemId => entriesByDocumentId.get(itemId)?.hasLocalChanges !== true)
  if (staleItemIds.length === 0) {
    return
  }

  void Promise.allSettled(staleItemIds.map(async itemId => {
    await refreshDocumentFromStorage(itemId)
    return itemId
  })).then(results => {
    const refreshedItemIds = results
      .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
      .map(result => result.value)

    if (refreshedItemIds.length === 0) {
      return
    }

    const itemIdsToNotify = refreshedItemIds.filter(itemId => !isMetadataDocumentId(itemId))
    if (itemIdsToNotify.length > 0) {
      notifyItemListeners(itemIdsToNotify)
    }

    if (refreshedItemIds.some(itemId => isMetadataDocumentId(itemId))) {
      notifyMetadataListeners()
    }
  })
}

export function getAutomergeItems(): Item[] {
  return memoizeMapValues(cachedItemSnapshotById)
}

export function getAutomergeItemIds(): string[] {
  return memoizeMapKeys(cachedItemSnapshotById)
}

export function getAutomergeItem(itemId: string): Item | null {
  if (isMetadataDocumentId(itemId)) {
    return null
  }

  return cachedItemSnapshotById.get(itemId) || null
}

export function getAutomergeMetadata(): AccountMetadata {
  return cachedMetadataSnapshot
}

function normalizeDocumentSnapshot(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeForAutomerge(input)
}

async function upsertAutomergeDocumentSnapshot(
  documentId: string,
  snapshot: Record<string, unknown>,
  options: { markLocalChange?: boolean } = {},
): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByDocumentId.get(documentId)
  const markLocalChange = options.markLocalChange !== false
  const nextHasLocalChanges = markLocalChange || existing?.hasLocalChanges === true
  const normalizedSnapshot = normalizeDocumentSnapshot(snapshot)
  const nextEntry = await setAutomergeWorkerSnapshot({
    documentId,
    snapshot: normalizedSnapshot,
    cursor: existing?.cursor,
    syncState: existing?.syncState,
  })

  applyWorkerEntry(nextEntry, {
    hasLocalChanges: nextHasLocalChanges,
  })
  await persistAutomergeEntry(loadedAccount, documentId, nextEntry.serialized, nextHasLocalChanges)
  notifyChange(documentId)
}

export async function seedAutomergeDocument(
  item: Item,
  options?: { markLocalChange?: boolean },
): Promise<void> {
  await upsertAutomergeDocumentSnapshot(item.id, item as unknown as Record<string, unknown>, options)
}

export async function upsertAutomergeMetadataSnapshot(
  metadata: AccountMetadata,
  options?: { markLocalChange?: boolean },
): Promise<void> {
  await upsertAutomergeDocumentSnapshot(
    ACCOUNT_METADATA_DOCUMENT_ID,
    (metadata || {}) as unknown as Record<string, unknown>,
    options,
  )
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  if (!loadedAccount) {
    return
  }

  await removeDocumentState(itemId)
  await removePersistedAutomergeEntry(loadedAccount, itemId)
  notifyChange(itemId)
}

export async function clearAutomergeDocStore(): Promise<void> {
  entriesByDocumentId.clear()
  clearCachedItemSnapshots()
  cachedSerializedByDocumentId.clear()
  loadedAccount = null
  cachedMetadataSnapshot = {}

  await clearPersistedAutomergeDocs()

  try {
    await resetAutomergeDocWorker()
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: 'automerge-doc-store',
        stage: 'clear-store-reset-worker',
      },
    })
  }

  notifyAllItemListeners()
  notifyMetadataListeners()
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  for (const item of items) {
    await seedAutomergeDocument(item)
  }
}

export async function exportAllBinaries(): Promise<Partial<Record<ItemId, string>>> {
  if (!loadedAccount) {
    return {}
  }

  const documents = await exportAutomergeWorkerBinaries()
  const encoded: Partial<Record<ItemId, string>> = {}

  for (const [itemId, binary] of Object.entries(documents)) {
    encoded[itemId as ItemId] = encodeBytesToBase64(binary)
  }

  return encoded
}

export async function restoreFromBinaries(documents: Partial<Record<ItemId, string>>): Promise<string[]> {
  if (!loadedAccount) {
    return []
  }

  const normalizedEntries = Array.from(new Set(Object.keys(documents || {})))
    .filter(documentId => (
      typeof documentId === 'string'
      && documentId.length > 0
      && !isMetadataDocumentId(documentId)
      && typeof documents[documentId] === 'string'
      && (documents[documentId] as string).length > 0
    ))

  if (normalizedEntries.length === 0) {
    return []
  }

  const restoredItemIds: string[] = []

  for (const itemId of normalizedEntries) {
    const encodedBinary = documents[itemId] as string
    const existing = entriesByDocumentId.get(itemId)

    try {
      const binary = decodeBase64ToBytes(encodedBinary)
      const nextEntry = await setAutomergeWorkerBinary({
        documentId: itemId,
        binary,
        cursor: existing?.cursor,
        syncState: existing?.syncState,
      })

      applyWorkerEntry(nextEntry, {
        hasLocalChanges: true,
      })
      await persistAutomergeEntry(loadedAccount, itemId, nextEntry.serialized, true)
      setCachedAutomergeBinary(itemId, binary)
      restoredItemIds.push(itemId)
    } catch (error) {
      console.error(`Failed to restore binary document for ${itemId}`, error)
    }
  }

  if (restoredItemIds.length === 0) {
    return []
  }

  notifyItemListeners(restoredItemIds)

  const { requestAutomergeSync } = await import('./automergeSyncDispatcher')
  requestAutomergeSync(restoredItemIds)

  return restoredItemIds
}

async function applyAutomergeDocumentPatches(
  documentId: string,
  patches: WorkerDocumentPatch[],
): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const workerPatches = normalizeWorkerDocumentPatches(patches)
  if (workerPatches.length === 0) {
    return
  }

  const existingEntry = entriesByDocumentId.get(documentId)

  const nextEntry = await applyAutomergeWorkerPatches({
    action: 'APPLY_DOCUMENT_PATCHES',
    documentId,
    patches: workerPatches,
    cursor: existingEntry?.cursor,
    syncState: existingEntry?.syncState,
  })

  applyWorkerEntry(nextEntry, {
    hasLocalChanges: true,
  })
  await persistAutomergeEntry(loadedAccount, documentId, nextEntry.serialized, true)
  notifyChange(documentId)
}

export async function applyAutomergeItemPatches(
  itemId: string,
  patches: WorkerDocumentPatch[],
): Promise<void> {
  await applyAutomergeDocumentPatches(itemId, patches)
}

export async function applyAutomergeMetadataPatches(
  patches: WorkerDocumentPatch[],
): Promise<void> {
  await applyAutomergeDocumentPatches(ACCOUNT_METADATA_DOCUMENT_ID, patches)
}

export function readAutomergeSyncCursor(itemId: string): number {
  return entriesByDocumentId.get(itemId)?.cursor || 0
}

export async function writeAutomergeSyncCursor(itemId: string, cursor: number): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByDocumentId.get(itemId)
  if (!existing) {
    return
  }

  const persisted = await setAutomergeWorkerCursor({
    documentId: itemId,
    cursor: Math.max(existing.cursor, cursor),
  })

  if (!persisted) {
    return
  }

  entriesByDocumentId.set(itemId, {
    cursor: persisted.cursor,
    syncState: persisted.syncState,
    hasLocalChanges: existing.hasLocalChanges,
  })
  cachedSerializedByDocumentId.set(itemId, {
    doc: new Uint8Array(persisted.doc),
    syncState: new Uint8Array(persisted.syncState),
    cursor: persisted.cursor,
  })

  await persistAutomergeEntry(loadedAccount, itemId, persisted, existing.hasLocalChanges)
}

export async function createAutomergeSyncMessage(
  itemId: string,
): Promise<{ message: Uint8Array | null; nextSyncState: SyncStateToken } | null> {
  const existing = entriesByDocumentId.get(itemId)
  if (!existing || !existing.hasLocalChanges) {
    return null
  }

  const generated = await createAutomergeWorkerSyncMessage(itemId)
  if (!generated) {
    return null
  }

  return {
    message: generated.message,
    nextSyncState: generated.nextSyncState,
  }
}

export async function commitAutomergeSyncState(itemId: string, syncState: SyncStateToken): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByDocumentId.get(itemId)
  if (!existing) {
    return
  }

  const persisted = await commitAutomergeWorkerSyncState({
    documentId: itemId,
    syncState,
  })

  if (!persisted) {
    return
  }

  entriesByDocumentId.set(itemId, {
    cursor: persisted.cursor,
    syncState: persisted.syncState,
    hasLocalChanges: false,
  })
  cachedSerializedByDocumentId.set(itemId, {
    doc: new Uint8Array(persisted.doc),
    syncState: new Uint8Array(persisted.syncState),
    cursor: persisted.cursor,
  })

  await persistAutomergeEntry(loadedAccount, itemId, persisted, false)
}

export async function receiveAutomergeSyncMessage(
  itemId: string,
  message: Uint8Array,
  cursor?: number,
): Promise<{ changed: boolean; cursor: number; serialized: WorkerSerializedEntry }> {
  if (!loadedAccount) {
    return {
      changed: false,
      cursor: 0,
      serialized: {
        doc: new Uint8Array(),
        syncState: new Uint8Array(),
        cursor: 0,
      },
    }
  }

  const existing = entriesByDocumentId.get(itemId)
  const nextHasLocalChanges = existing?.hasLocalChanges === true
  const nextEntry = await receiveAutomergeWorkerSyncMessage({
    documentId: itemId,
    message,
    cursor,
    syncState: existing?.syncState,
  })

  applyWorkerEntry(nextEntry, {
    hasLocalChanges: nextHasLocalChanges,
  })

  // Persist doc + sync state + cursor together as a single write payload.
  await persistAutomergeEntry(loadedAccount, itemId, nextEntry.serialized, nextHasLocalChanges)

  if (nextEntry.changed) {
    notifyChange(itemId)
  }

  return {
    changed: nextEntry.changed,
    cursor: nextEntry.serialized.cursor,
    serialized: nextEntry.serialized,
  }
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  return reactivity.subscribeAutomergeItems(listener)
}

export function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
  return reactivity.subscribeAutomergeItem(itemId, listener)
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  return reactivity.subscribeAutomergeMetadata(listener)
}

import type { Item } from '../state/items'
import { supplyMissingAttributes } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import type { ItemId } from '../shared/itemTypes'
import {
  clearPersistedAutomergeDocs,
  listPersistedAutomergeDocs,
  readPersistedAutomergeDoc,
  removePersistedAutomergeDoc,
  type PersistedDocRecord,
  writePersistedAutomergeDoc,
} from './automergeDocStorage'
import {
  emitAutomergeItemRevision,
  emitAutomergeItemsRevision,
  emitAutomergeMetadataRevision,
  subscribeAutomergeItemRevision,
  subscribeAutomergeItemsRevision,
  subscribeAutomergeMetadataRevision,
} from './automergeDocReactiveStore'
import { setCachedAutomergeBinary } from './automergeBinaryCache'
import {
  commitAutomergeWorkerSyncState,
  createAutomergeWorkerSyncMessage,
  exportAutomergeWorkerBinaries,
  initializeAutomergeWorkerDocs,
  loadAutomergeWorkerRecord,
  receiveAutomergeWorkerSyncMessage,
  removeAutomergeWorkerDocument,
  resetAutomergeDocWorker,
  setAutomergeWorkerBinary,
  setAutomergeWorkerCursor,
  setAutomergeWorkerSnapshot,
  type PersistedWorkerRecord,
  type WorkerEntrySnapshot,
  type WorkerSerializedEntry,
} from '../workers/automergeDocWorkerManager'

export const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

export type SyncStateToken = string

type DocEntry = {
  syncState: SyncStateToken
  cursor: number
  hasLocalChanges: boolean
}

let loadedAccount: string | null = null
const entriesByDocumentId = new Map<string, DocEntry>()
const documentSnapshotsById = new Map<string, Record<string, unknown>>()
const cachedItemSnapshotById = new Map<string, Item | null>()
let cachedItemsSnapshot: Item[] = []
let cachedItemsSnapshotDirty = true
let cachedMetadataSnapshot: AccountMetadata = {}
let cachedMetadataSnapshotDirty = true

function markItemsSnapshotDirty(): void {
  cachedItemsSnapshotDirty = true
}

function markMetadataSnapshotDirty(): void {
  cachedMetadataSnapshotDirty = true
}

function isMetadataDocumentId(documentId: string): boolean {
  return documentId === ACCOUNT_METADATA_DOCUMENT_ID
}

function getInitialDocumentSnapshot(documentId: string): Record<string, unknown> {
  if (isMetadataDocumentId(documentId)) {
    return {}
  }

  return { id: documentId }
}

function materializeItem(itemId: string, snapshot: Record<string, unknown>): Item | null {
  const candidate = {
    ...snapshot,
  }

  if (typeof candidate.id !== 'string') {
    candidate.id = itemId
  }

  if (typeof candidate.type !== 'string') {
    return null
  }

  try {
    return supplyMissingAttributes(candidate as unknown as Item)
  } catch {
    return null
  }
}

function pruneUndefinedDeepInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] === undefined) {
        value.splice(index, 1)
        continue
      }

      pruneUndefinedDeepInPlace(value[index])
    }
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  const target = value as Record<string, unknown>
  for (const key of Object.keys(target)) {
    const nested = target[key]
    if (nested === undefined) {
      delete target[key]
      continue
    }

    pruneUndefinedDeepInPlace(nested)
  }
}

function normalizeForAutomerge(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(input)
  pruneUndefinedDeepInPlace(normalized)
  return normalized
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function toPersistedWorkerRecord(value: PersistedDocRecord): PersistedWorkerRecord {
  return {
    itemId: value.itemId,
    doc: value.doc,
    syncState: value.syncState,
    cursor: value.cursor,
  }
}

async function persistEntry(
  account: string,
  itemId: string,
  serialized: WorkerSerializedEntry,
  hasLocalChanges: boolean,
): Promise<void> {
  const persisted: PersistedDocRecord = {
    account,
    itemId,
    doc: serialized.doc,
    syncState: serialized.syncState,
    cursor: serialized.cursor,
    hasLocalChanges,
    updatedAt: Date.now(),
  }

  await writePersistedAutomergeDoc(account, itemId, persisted)
}

function applyWorkerEntry(entry: WorkerEntrySnapshot, options?: { hasLocalChanges?: boolean }): void {
  const existing = entriesByDocumentId.get(entry.documentId)
  entriesByDocumentId.set(entry.documentId, {
    cursor: entry.serialized.cursor,
    syncState: entry.serialized.syncState,
    hasLocalChanges: options?.hasLocalChanges ?? existing?.hasLocalChanges ?? false,
  })
  documentSnapshotsById.set(entry.documentId, entry.snapshot)
}

async function removeDocumentState(documentId: string): Promise<void> {
  entriesByDocumentId.delete(documentId)
  documentSnapshotsById.delete(documentId)
  cachedItemSnapshotById.delete(documentId)

  try {
    await removeAutomergeWorkerDocument(documentId)
  } catch {
    // keep local state coherent even if worker unload fails
  }
}

function notifyChange(documentId: string): void {
  cachedItemSnapshotById.delete(documentId)

  if (isMetadataDocumentId(documentId)) {
    markMetadataSnapshotDirty()
    emitAutomergeMetadataRevision()
    return
  }

  markItemsSnapshotDirty()
  emitAutomergeItemRevision(documentId)
  emitAutomergeItemsRevision()
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  if (loadedAccount === account) {
    return
  }

  loadedAccount = account
  entriesByDocumentId.clear()
  documentSnapshotsById.clear()
  cachedItemSnapshotById.clear()
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()

  const persistedRecords = await listPersistedAutomergeDocs(account)
  const localChangesByDocumentId = new Map(
    persistedRecords.map(record => [record.itemId, record.hasLocalChanges === true]),
  )

  try {
    const initializedEntries = await initializeAutomergeWorkerDocs(
      persistedRecords.map(toPersistedWorkerRecord),
    )

    for (const entry of initializedEntries) {
      applyWorkerEntry(entry, {
        hasLocalChanges: localChangesByDocumentId.get(entry.documentId) === true,
      })
    }
  } catch (error) {
    console.error('Failed to initialize automerge document worker state', error)
  }

  emitAutomergeItemsRevision()
  emitAutomergeMetadataRevision()
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
  if (!loadedAccount) {
    return
  }

  const stored = await readPersistedAutomergeDoc(loadedAccount, documentId)

  if (!stored || typeof stored !== 'object') {
    await removeDocumentState(documentId)
    return
  }

  try {
    const loaded = await loadAutomergeWorkerRecord(toPersistedWorkerRecord(stored))
    if (!loaded) {
      await removeDocumentState(documentId)
      return
    }

    applyWorkerEntry(loaded, {
      hasLocalChanges: stored.hasLocalChanges === true,
    })
  } catch {
    await removeDocumentState(documentId)
  }
}

export function invalidateCachedItems(itemIds: string[]): void {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => typeof itemId === 'string' && itemId.length > 0)))
  if (uniqueItemIds.length === 0) {
    return
  }

  for (const itemId of uniqueItemIds) {
    cachedItemSnapshotById.delete(itemId)
  }

  markItemsSnapshotDirty()
  const hasMetadataItem = uniqueItemIds.some(itemId => isMetadataDocumentId(itemId))
  if (hasMetadataItem) {
    markMetadataSnapshotDirty()
  }

  void Promise.all(uniqueItemIds.map(itemId => refreshDocumentFromStorage(itemId))).finally(() => {
    let hasAnyItemUpdate = false

    for (const itemId of uniqueItemIds) {
      if (isMetadataDocumentId(itemId)) {
        emitAutomergeMetadataRevision()
      } else {
        hasAnyItemUpdate = true
        emitAutomergeItemRevision(itemId)
      }
    }

    if (hasAnyItemUpdate) {
      emitAutomergeItemsRevision()
    }
  })
}

export function getAutomergeItems(): Item[] {
  if (!cachedItemsSnapshotDirty) {
    return cachedItemsSnapshot
  }

  const items: Item[] = []

  for (const [itemId] of entriesByDocumentId) {
    if (isMetadataDocumentId(itemId)) {
      continue
    }

    const snapshot = documentSnapshotsById.get(itemId)
    if (!snapshot) {
      continue
    }

    const item = materializeItem(itemId, snapshot)
    if (!item || item.deleted === true) {
      continue
    }

    items.push(item)
  }

  cachedItemsSnapshot = items
  cachedItemsSnapshotDirty = false
  return cachedItemsSnapshot
}

export function getAutomergeItem(itemId: string): Item | null {
  if (isMetadataDocumentId(itemId)) {
    return null
  }

  if (cachedItemSnapshotById.has(itemId)) {
    return cachedItemSnapshotById.get(itemId) || null
  }

  const snapshot = documentSnapshotsById.get(itemId)
  if (!snapshot) {
    cachedItemSnapshotById.set(itemId, null)
    return null
  }

  const item = materializeItem(itemId, snapshot)
  if (!item || item.deleted === true) {
    cachedItemSnapshotById.set(itemId, null)
    return null
  }

  cachedItemSnapshotById.set(itemId, item)
  return item
}

export function getAutomergeMetadata(): AccountMetadata {
  if (!cachedMetadataSnapshotDirty) {
    return cachedMetadataSnapshot
  }

  const snapshot = documentSnapshotsById.get(ACCOUNT_METADATA_DOCUMENT_ID)
  if (!snapshot) {
    cachedMetadataSnapshot = {}
    cachedMetadataSnapshotDirty = false
    return cachedMetadataSnapshot
  }

  const normalized = {
    ...snapshot,
  }
  delete normalized.id

  cachedMetadataSnapshot = normalized as AccountMetadata
  cachedMetadataSnapshotDirty = false
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
  await persistEntry(loadedAccount, documentId, nextEntry.serialized, nextHasLocalChanges)
  notifyChange(documentId)
}

export async function upsertAutomergeItemSnapshot(
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
  await removePersistedAutomergeDoc(loadedAccount, itemId)
  notifyChange(itemId)
}

export async function clearAutomergeDocStore(): Promise<void> {
  entriesByDocumentId.clear()
  documentSnapshotsById.clear()
  cachedItemSnapshotById.clear()
  loadedAccount = null
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()

  await clearPersistedAutomergeDocs()

  try {
    await resetAutomergeDocWorker()
  } catch {
    // reset failure should not block local clearing
  }

  emitAutomergeItemsRevision()
  emitAutomergeMetadataRevision()
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  for (const item of items) {
    await upsertAutomergeItemSnapshot(item)
  }
}

export async function exportAllBinaries(): Promise<Partial<Record<ItemId, string>>> {
  if (!loadedAccount) {
    return {}
  }

  const documents = await exportAutomergeWorkerBinaries()
  return documents as Partial<Record<ItemId, string>>
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
      const nextEntry = await setAutomergeWorkerBinary({
        documentId: itemId,
        binary: encodedBinary,
        cursor: existing?.cursor,
        syncState: existing?.syncState,
      })

      applyWorkerEntry(nextEntry, {
        hasLocalChanges: true,
      })
      await persistEntry(loadedAccount, itemId, nextEntry.serialized, true)
      cachedItemSnapshotById.delete(itemId)
      setCachedAutomergeBinary(itemId, decodeBase64ToBytes(encodedBinary))
      restoredItemIds.push(itemId)
    } catch (error) {
      console.error(`Failed to restore binary document for ${itemId}`, error)
    }
  }

  if (restoredItemIds.length === 0) {
    return []
  }

  markItemsSnapshotDirty()

  for (const itemId of restoredItemIds) {
    emitAutomergeItemRevision(itemId)
  }
  emitAutomergeItemsRevision()

  const { requestAutomergeSync } = await import('./automergeSyncDispatcher')
  requestAutomergeSync(restoredItemIds)

  return restoredItemIds
}

async function withAutomergeDocumentChange(
  documentId: string,
  mutate: (draft: Record<string, unknown>) => void,
): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existingSnapshot = documentSnapshotsById.get(documentId) || getInitialDocumentSnapshot(documentId)
  const draft = structuredClone(existingSnapshot)
  mutate(draft)
  await upsertAutomergeDocumentSnapshot(documentId, draft)
}

export async function withAutomergeItemChange(
  itemId: string,
  mutate: (draft: Record<string, unknown>) => void,
): Promise<void> {
  await withAutomergeDocumentChange(itemId, mutate)
}

export async function withAutomergeMetadataChange(
  mutate: (draft: Record<string, unknown>) => void,
): Promise<void> {
  await withAutomergeDocumentChange(ACCOUNT_METADATA_DOCUMENT_ID, mutate)
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
  await persistEntry(loadedAccount, itemId, persisted, existing.hasLocalChanges)
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
  await persistEntry(loadedAccount, itemId, persisted, false)
}

export async function receiveAutomergeSyncMessage(itemId: string, message: Uint8Array): Promise<boolean> {
  if (!loadedAccount) {
    return false
  }

  const existing = entriesByDocumentId.get(itemId)
  const nextHasLocalChanges = existing?.hasLocalChanges === true
  const nextEntry = await receiveAutomergeWorkerSyncMessage({
    documentId: itemId,
    message,
    cursor: existing?.cursor,
    syncState: existing?.syncState,
  })

  applyWorkerEntry(nextEntry, {
    hasLocalChanges: nextHasLocalChanges,
  })
  await persistEntry(loadedAccount, itemId, nextEntry.serialized, nextHasLocalChanges)

  if (nextEntry.changed) {
    notifyChange(itemId)
  }

  return nextEntry.changed
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  return subscribeAutomergeItemsRevision(listener)
}

export function subscribeAutomergeItem(itemId: string, listener: (item: Item | null) => void): () => void {
  return subscribeAutomergeItemRevision(itemId, () => {
    listener(getAutomergeItem(itemId))
  })
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  return subscribeAutomergeMetadataRevision(listener)
}

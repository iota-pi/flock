import type { Item } from '../state/items'
import * as Sentry from '@sentry/react'
import { supplyMissingAttributes } from '../state/items'
import { createStore } from 'zustand/vanilla'
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
import { setCachedAutomergeBinary } from './automergeBinaryCache'
import {
  applyAutomergeWorkerPatches,
  commitAutomergeWorkerSyncState,
  createAutomergeWorkerSyncMessage,
  exportAutomergeWorkerBinaries,
  initializeAutomergeWorkerDocs,
  mergeAutomergeWorkerRecord,
  receiveAutomergeWorkerSyncMessage,
  removeAutomergeWorkerDocument,
  resetAutomergeDocWorker,
  setAutomergeWorkerRehydrateProvider,
  setAutomergeWorkerBinary,
  setAutomergeWorkerCursor,
  setAutomergeWorkerSnapshot,
  type WorkerDocumentPatch,
  type PersistedWorkerRecord,
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
const cachedItemSnapshotById = new Map<string, Item>()
let cachedItemsSnapshot: Item[] = []
let cachedItemsSnapshotDirty = true
let cachedItemIdsSnapshot: string[] = []
let cachedMetadataSnapshot: AccountMetadata = {}
let cachedMetadataSnapshotDirty = true
const cachedSerializedByDocumentId = new Map<string, WorkerSerializedEntry>()

type ReactivityState = {
  itemsRevision: number
  metadataRevision: number
  itemRevisionById: Record<string, number>
}

const reactivityStore = createStore<ReactivityState>(() => ({
  itemsRevision: 0,
  metadataRevision: 0,
  itemRevisionById: {},
}))

function markItemsSnapshotDirty(): void {
  cachedItemsSnapshotDirty = true
}

function markMetadataSnapshotDirty(): void {
  cachedMetadataSnapshotDirty = true
}

function getRehydrateCacheRecords(): PersistedWorkerRecord[] {
  const records: PersistedWorkerRecord[] = []

  for (const [documentId, entry] of entriesByDocumentId) {
    const serialized = cachedSerializedByDocumentId.get(documentId)
    if (!serialized) {
      continue
    }

    records.push({
      itemId: documentId,
      doc: new Uint8Array(serialized.doc),
      syncState: new Uint8Array(serialized.syncState),
      cursor: entry.cursor,
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

function asUint8Array(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? decodeBase64ToBytes(value) : value
}

function isMetadataDocumentId(documentId: string): boolean {
  return documentId === ACCOUNT_METADATA_DOCUMENT_ID
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
    return null
  }
}

const MAX_PRUNE_DEPTH = 20

function pruneUndefinedDeepInPlace(value: unknown): void {
  const visited = new WeakSet<object>()
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) {
      continue
    }

    const { node, depth } = current

    if (depth > MAX_PRUNE_DEPTH) {
      throw new Error(`Input exceeds maximum nesting depth of ${MAX_PRUNE_DEPTH}`)
    }

    if (!node || typeof node !== 'object') {
      continue
    }

    if (visited.has(node as object)) {
      continue
    }
    visited.add(node as object)

    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        if (node[index] === undefined) {
          node[index] = null
          continue
        }

        if (node[index] && typeof node[index] === 'object') {
          stack.push({
            node: node[index],
            depth: depth + 1,
          })
        }
      }
      continue
    }

    const target = node as Record<string, unknown>
    for (const key of Object.keys(target)) {
      const nested = target[key]
      if (nested === undefined) {
        delete target[key]
        continue
      }

      if (nested && typeof nested === 'object') {
        stack.push({
          node: nested,
          depth: depth + 1,
        })
      }
    }
  }
}

function normalizeForAutomerge(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(input)
  pruneUndefinedDeepInPlace(normalized)
  return normalized
}

function isPatchPathSegment(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
}

function normalizePatchValue(value: unknown): unknown {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const cloned = structuredClone(value)
    pruneUndefinedDeepInPlace(cloned)
    return cloned
  }

  return value
}

function normalizeWorkerDocumentPatches(patches: WorkerDocumentPatch[]): WorkerDocumentPatch[] {
  const normalizedPatches: WorkerDocumentPatch[] = []

  for (const patch of patches) {
    const path = patch && Array.isArray(patch.path) ? patch.path : []
    if (path.length === 0 || path.some(segment => !isPatchPathSegment(segment))) {
      continue
    }

    if (patch.op === 'remove') {
      normalizedPatches.push({
        op: 'remove',
        path,
      })
      continue
    }

    if (patch.op !== 'add' && patch.op !== 'replace') {
      continue
    }

    if (patch.value === undefined) {
      normalizedPatches.push({
        op: 'remove',
        path,
      })
      continue
    }

    normalizedPatches.push({
      op: patch.op,
      path,
      value: normalizePatchValue(patch.value),
    })
  }

  return normalizedPatches
}

function toPersistedWorkerRecord(value: PersistedDocRecord): PersistedWorkerRecord {
  return {
    itemId: value.itemId,
    doc: asUint8Array(value.doc),
    syncState: asUint8Array(value.syncState),
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

function setCachedItemFromSnapshot(documentId: string, snapshot: Record<string, unknown>): void {
  const item = materializeItem(documentId, snapshot)
  if (!item || item.deleted === true) {
    cachedItemSnapshotById.delete(documentId)
    return
  }

  cachedItemSnapshotById.set(documentId, item)
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
  reactivityStore.setState(state => ({
    ...state,
    itemsRevision: state.itemsRevision + 1,
  }))
}

function notifyItemListeners(itemIds: string[]): void {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => typeof itemId === 'string' && itemId.length > 0)))
  if (uniqueItemIds.length === 0) {
    return
  }

  markItemsSnapshotDirty()

  reactivityStore.setState(state => {
    const nextItemRevisionById = {
      ...state.itemRevisionById,
    }

    for (const itemId of uniqueItemIds) {
      nextItemRevisionById[itemId] = (nextItemRevisionById[itemId] || 0) + 1
    }

    return {
      ...state,
      itemsRevision: state.itemsRevision + 1,
      itemRevisionById: nextItemRevisionById,
    }
  })
}

function notifyMetadataListeners(): void {
  markMetadataSnapshotDirty()

  reactivityStore.setState(state => ({
    ...state,
    metadataRevision: state.metadataRevision + 1,
  }))
}

async function removeDocumentState(documentId: string): Promise<void> {
  entriesByDocumentId.delete(documentId)
  cachedSerializedByDocumentId.delete(documentId)

  if (isMetadataDocumentId(documentId)) {
    cachedMetadataSnapshot = {}
  } else {
    cachedItemSnapshotById.delete(documentId)
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

  loadedAccount = account
  entriesByDocumentId.clear()
  cachedItemSnapshotById.clear()
  cachedSerializedByDocumentId.clear()
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedItemIdsSnapshot = []
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()

  const persistedRecords = await listPersistedAutomergeDocs(account)
  const localChangesByDocumentId = new Map(
    persistedRecords.map(record => [record.itemId, record.hasLocalChanges === true]),
  )

  try {
    const initializedEntries = await initializeAutomergeWorkerDocs(
      account,
      persistedRecords.map(toPersistedWorkerRecord),
    )

    for (const entry of initializedEntries) {
      applyWorkerEntry(entry, {
        hasLocalChanges: localChangesByDocumentId.get(entry.documentId) === true,
      })
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        area: 'automerge-doc-store',
        stage: 'initialize-worker-docs',
      },
      extra: {
        account,
      },
    })

    console.error('Failed to initialize automerge document worker state', error)
  }

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
  if (entriesByDocumentId.get(documentId)?.hasLocalChanges === true) {
    return
  }

  if (!loadedAccount) {
    return
  }

  const stored = await readPersistedAutomergeDoc(loadedAccount, documentId)

  if (!stored || typeof stored !== 'object') {
    await removeDocumentState(documentId)
    return
  }

  try {
    const merged = await mergeAutomergeWorkerRecord(toPersistedWorkerRecord(stored))
    if (!merged) {
      await removeDocumentState(documentId)
      return
    }

    // Do not let stale persistence reads overwrite fresher in-memory local edits.
    if (entriesByDocumentId.get(documentId)?.hasLocalChanges === true) {
      return
    }

    const nextHasLocalChanges = stored.hasLocalChanges === true
      || entriesByDocumentId.get(documentId)?.hasLocalChanges === true

    applyWorkerEntry(merged, {
      hasLocalChanges: nextHasLocalChanges,
    })

    if (loadedAccount) {
      await persistEntry(loadedAccount, documentId, merged.serialized, nextHasLocalChanges)
    }
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
  if (!cachedItemsSnapshotDirty) {
    return cachedItemsSnapshot
  }

  cachedItemsSnapshot = Array.from(cachedItemSnapshotById.values())
  cachedItemsSnapshotDirty = false
  return cachedItemsSnapshot
}

export function getAutomergeItemIds(): string[] {
  const nextIds = Array.from(cachedItemSnapshotById.keys())
  if (
    nextIds.length === cachedItemIdsSnapshot.length
    && nextIds.every((itemId, index) => itemId === cachedItemIdsSnapshot[index])
  ) {
    return cachedItemIdsSnapshot
  }

  cachedItemIdsSnapshot = nextIds
  return cachedItemIdsSnapshot
}

export function getAutomergeItem(itemId: string): Item | null {
  if (isMetadataDocumentId(itemId)) {
    return null
  }

  return cachedItemSnapshotById.get(itemId) || null
}

export function getAutomergeMetadata(): AccountMetadata {
  if (!cachedMetadataSnapshotDirty) {
    return cachedMetadataSnapshot
  }

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
  await removePersistedAutomergeDoc(loadedAccount, itemId)
  notifyChange(itemId)
}

export async function clearAutomergeDocStore(): Promise<void> {
  entriesByDocumentId.clear()
  cachedItemSnapshotById.clear()
  cachedSerializedByDocumentId.clear()
  loadedAccount = null
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedItemIdsSnapshot = []
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()

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
      await persistEntry(loadedAccount, itemId, nextEntry.serialized, true)
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
  await persistEntry(loadedAccount, documentId, nextEntry.serialized, true)
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

export async function receiveAutomergeSyncMessage(
  itemId: string,
  message: Uint8Array,
  cursor?: number,
): Promise<{ changed: boolean; cursor: number }> {
  if (!loadedAccount) {
    return { changed: false, cursor: 0 }
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
  await persistEntry(loadedAccount, itemId, nextEntry.serialized, nextHasLocalChanges)

  if (nextEntry.changed) {
    notifyChange(itemId)
  }

  return {
    changed: nextEntry.changed,
    cursor: nextEntry.serialized.cursor,
  }
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  return reactivityStore.subscribe((state, previousState) => {
    if (state.itemsRevision !== previousState.itemsRevision) {
      listener()
    }
  })
}

export function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
  return reactivityStore.subscribe((state, previousState) => {
    const nextSignal = `${state.itemsRevision}:${state.itemRevisionById[itemId] || 0}`
    const previousSignal = `${previousState.itemsRevision}:${previousState.itemRevisionById[itemId] || 0}`

    if (nextSignal !== previousSignal) {
      listener()
    }
  })
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  return reactivityStore.subscribe((state, previousState) => {
    if (state.metadataRevision !== previousState.metadataRevision) {
      listener()
    }
  })
}

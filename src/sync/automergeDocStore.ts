import * as Automerge from '@automerge/automerge'
import type { Item } from '../state/items'
import { supplyMissingAttributes } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { fromBytes, toBytes } from '../api/vault/crypto'
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

export const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

type SyncState = ReturnType<typeof Automerge.initSyncState>

type DocEntry = {
  doc: Automerge.Doc<Record<string, unknown>>
  syncState: SyncState
  cursor: number
}

let loadedAccount: string | null = null
const entriesByDocumentId = new Map<string, DocEntry>()
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

function decodeBytes(base64: string): Uint8Array {
  const bytes = toBytes(base64)
  return new Uint8Array(bytes)
}

function encodeBytes(bytes: Uint8Array): string {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return fromBytes(buffer)
}

function materializeItem(itemId: string, doc: Automerge.Doc<Record<string, unknown>>): Item | null {
  const candidate = {
    ...(doc as unknown as Record<string, unknown>),
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

async function persistEntry(account: string, itemId: string, entry: DocEntry): Promise<void> {
  const persisted: PersistedDocRecord = {
    account,
    itemId,
    doc: encodeBytes(Automerge.save(entry.doc)),
    syncState: encodeBytes(Automerge.encodeSyncState(entry.syncState)),
    cursor: entry.cursor,
    updatedAt: Date.now(),
  }

  await writePersistedAutomergeDoc(account, itemId, persisted)
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
  cachedItemSnapshotById.clear()
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()

  const persistedRecords = await listPersistedAutomergeDocs(account)
  for (const value of persistedRecords) {
    try {
      const docBinary = decodeBytes(value.doc)
      const encodedSyncState = decodeBytes(value.syncState)
      const doc = Automerge.load<Record<string, unknown>>(docBinary)
      const syncState = Automerge.decodeSyncState(encodedSyncState)

      entriesByDocumentId.set(value.itemId, {
        doc,
        syncState,
        cursor: typeof value.cursor === 'number' ? value.cursor : 0,
      })
    } catch {
      // Ignore invalid records to keep local store robust.
    }
  }

  emitAutomergeItemsRevision()
  emitAutomergeMetadataRevision()
}

export function listAutomergeDocumentIds(): string[] {
  return Array.from(entriesByDocumentId.keys())
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
    entriesByDocumentId.delete(documentId)
    return
  }

  try {
    const docBinary = decodeBytes(stored.doc)
    const encodedSyncState = decodeBytes(stored.syncState)
    const doc = Automerge.load<Record<string, unknown>>(docBinary)
    const syncState = Automerge.decodeSyncState(encodedSyncState)

    entriesByDocumentId.set(documentId, {
      doc,
      syncState,
      cursor: typeof stored.cursor === 'number' ? stored.cursor : 0,
    })
  } catch {
    entriesByDocumentId.delete(documentId)
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

  for (const [itemId, entry] of entriesByDocumentId) {
    if (isMetadataDocumentId(itemId)) {
      continue
    }

    const item = materializeItem(itemId, entry.doc)
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

  const entry = entriesByDocumentId.get(itemId)
  if (!entry) {
    cachedItemSnapshotById.set(itemId, null)
    return null
  }

  const item = materializeItem(itemId, entry.doc)
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

  const entry = entriesByDocumentId.get(ACCOUNT_METADATA_DOCUMENT_ID)
  if (!entry) {
    cachedMetadataSnapshot = {}
    cachedMetadataSnapshotDirty = false
    return cachedMetadataSnapshot
  }

  const snapshot = {
    ...(entry.doc as unknown as Record<string, unknown>),
  }
  delete snapshot.id

  cachedMetadataSnapshot = snapshot as AccountMetadata
  cachedMetadataSnapshotDirty = false
  return cachedMetadataSnapshot
}

function normalizeDocumentSnapshot(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeForAutomerge(input)
}

async function upsertAutomergeDocumentSnapshot(documentId: string, snapshot: Record<string, unknown>): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const normalizedSnapshot = normalizeDocumentSnapshot(snapshot)
  const existing = entriesByDocumentId.get(documentId)
  const nextDoc = existing
    ? Automerge.change(existing.doc, draft => {
      for (const key of Object.keys(draft)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, normalizedSnapshot)
      pruneUndefinedDeepInPlace(draft)
    })
    : Automerge.from(normalizedSnapshot)

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: existing?.syncState || Automerge.initSyncState(),
    cursor: existing?.cursor || 0,
  }

  entriesByDocumentId.set(documentId, nextEntry)
  await persistEntry(loadedAccount, documentId, nextEntry)
  notifyChange(documentId)
}

export async function upsertAutomergeItemSnapshot(item: Item): Promise<void> {
  await upsertAutomergeDocumentSnapshot(item.id, item as unknown as Record<string, unknown>)
}

export async function upsertAutomergeMetadataSnapshot(metadata: AccountMetadata): Promise<void> {
  await upsertAutomergeDocumentSnapshot(
    ACCOUNT_METADATA_DOCUMENT_ID,
    (metadata || {}) as unknown as Record<string, unknown>,
  )
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  if (!loadedAccount) {
    return
  }

  entriesByDocumentId.delete(itemId)
  await removePersistedAutomergeDoc(loadedAccount, itemId)
  notifyChange(itemId)
}

export async function clearAutomergeDocStore(): Promise<void> {
  entriesByDocumentId.clear()
  cachedItemSnapshotById.clear()
  loadedAccount = null
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  cachedMetadataSnapshot = {}
  markMetadataSnapshotDirty()
  await clearPersistedAutomergeDocs()
  emitAutomergeItemsRevision()
  emitAutomergeMetadataRevision()
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  for (const item of items) {
    await upsertAutomergeItemSnapshot(item)
  }
}

async function withAutomergeDocumentChange(
  documentId: string,
  mutate: (draft: Record<string, unknown>) => void,
): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByDocumentId.get(documentId)
  const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>(getInitialDocumentSnapshot(documentId))

  const nextDoc = Automerge.change(baseDoc, draft => {
    mutate(draft as Record<string, unknown>)
    pruneUndefinedDeepInPlace(draft)
  })

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: existing?.syncState || Automerge.initSyncState(),
    cursor: existing?.cursor || 0,
  }

  entriesByDocumentId.set(documentId, nextEntry)
  await persistEntry(loadedAccount, documentId, nextEntry)
  notifyChange(documentId)
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

  existing.cursor = Math.max(existing.cursor, cursor)
  await persistEntry(loadedAccount, itemId, existing)
}

export function createAutomergeSyncMessage(itemId: string): { message: Uint8Array | null; nextSyncState: SyncState } | null {
  const entry = entriesByDocumentId.get(itemId)
  if (!entry) {
    return null
  }

  const [nextSyncState, message] = Automerge.generateSyncMessage(entry.doc, entry.syncState)
  return {
    message,
    nextSyncState,
  }
}

export async function commitAutomergeSyncState(itemId: string, syncState: SyncState): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const entry = entriesByDocumentId.get(itemId)
  if (!entry) {
    return
  }

  entry.syncState = syncState
  await persistEntry(loadedAccount, itemId, entry)
}

export async function receiveAutomergeSyncMessage(itemId: string, message: Uint8Array): Promise<boolean> {
  if (!loadedAccount) {
    return false
  }

  const existing = entriesByDocumentId.get(itemId)
  const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>(getInitialDocumentSnapshot(itemId))
  const baseSyncState = existing?.syncState || Automerge.initSyncState()

  const [nextDoc, nextSyncState] = Automerge.receiveSyncMessage(baseDoc, baseSyncState, message)

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: nextSyncState,
    cursor: existing?.cursor || 0,
  }

  entriesByDocumentId.set(itemId, nextEntry)
  await persistEntry(loadedAccount, itemId, nextEntry)
  notifyChange(itemId)
  return true
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

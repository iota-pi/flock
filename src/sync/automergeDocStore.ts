import * as Automerge from '@automerge/automerge'
import localforage from 'localforage'
import type { Item } from '../state/items'
import { supplyMissingAttributes } from '../state/items'
import { fromBytes, toBytes } from '../api/vault/crypto'

const STORE_NAME = 'automerge-documents'
const DOC_RECORD_PREFIX = 'doc:'

type SyncState = ReturnType<typeof Automerge.initSyncState>

type PersistedDocRecord = {
  account: string
  itemId: string
  doc: string
  syncState: string
  cursor: number
  updatedAt: number
}

type DocEntry = {
  doc: Automerge.Doc<Record<string, unknown>>
  syncState: SyncState
  cursor: number
}

const store = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: STORE_NAME,
})

let loadedAccount: string | null = null
const entriesByItemId = new Map<string, DocEntry>()
const cachedItemSnapshotById = new Map<string, Item | null>()
const allListeners = new Set<() => void>()
const itemListenersById = new Map<string, Set<(item: Item | null) => void>>()
let cachedItemsSnapshot: Item[] = []
let cachedItemsSnapshotDirty = true

function markItemsSnapshotDirty(): void {
  cachedItemsSnapshotDirty = true
}

function toDocStorageKey(account: string, itemId: string): string {
  return `${DOC_RECORD_PREFIX}${account}:${itemId}`
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

  await store.setItem(toDocStorageKey(account, itemId), persisted)
}

function notifyItem(itemId: string): void {
  const item = getAutomergeItem(itemId)
  const listeners = itemListenersById.get(itemId)
  if (listeners) {
    for (const listener of listeners) {
      listener(item)
    }
  }
}

function notifyAll(): void {
  for (const listener of allListeners) {
    listener()
  }
}

function notifyChange(itemId: string): void {
  markItemsSnapshotDirty()
  cachedItemSnapshotById.delete(itemId)
  notifyItem(itemId)
  notifyAll()
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  if (loadedAccount === account) {
    return
  }

  loadedAccount = account
  entriesByItemId.clear()
  cachedItemSnapshotById.clear()
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()

  await store.iterate<PersistedDocRecord, void>((value, key) => {
    if (!key.startsWith(`${DOC_RECORD_PREFIX}${account}:`)) {
      return
    }

    if (!value || typeof value !== 'object' || typeof value.itemId !== 'string') {
      return
    }

    try {
      const docBinary = decodeBytes(value.doc)
      const encodedSyncState = decodeBytes(value.syncState)
      const doc = Automerge.load<Record<string, unknown>>(docBinary)
      const syncState = Automerge.decodeSyncState(encodedSyncState)

      entriesByItemId.set(value.itemId, {
        doc,
        syncState,
        cursor: typeof value.cursor === 'number' ? value.cursor : 0,
      })
    } catch {
      // Ignore invalid records to keep local store robust.
    }
  })

  notifyAll()
}

export function listAutomergeItemIds(): string[] {
  return Array.from(entriesByItemId.keys())
}

export function getAutomergeItems(): Item[] {
  if (!cachedItemsSnapshotDirty) {
    return cachedItemsSnapshot
  }

  const items: Item[] = []

  for (const [itemId, entry] of entriesByItemId) {
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
  if (cachedItemSnapshotById.has(itemId)) {
    return cachedItemSnapshotById.get(itemId) || null
  }

  const entry = entriesByItemId.get(itemId)
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

export async function upsertAutomergeItemSnapshot(item: Item): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const normalizedItem = normalizeForAutomerge(item as unknown as Record<string, unknown>)
  const existing = entriesByItemId.get(item.id)
  const nextDoc = existing
    ? Automerge.change(existing.doc, draft => {
      for (const key of Object.keys(draft)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, normalizedItem)
      pruneUndefinedDeepInPlace(draft)
    })
    : Automerge.from(normalizedItem)

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: existing?.syncState || Automerge.initSyncState(),
    cursor: existing?.cursor || 0,
  }

  entriesByItemId.set(item.id, nextEntry)
  await persistEntry(loadedAccount, item.id, nextEntry)
  notifyChange(item.id)
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  if (!loadedAccount) {
    return
  }

  entriesByItemId.delete(itemId)
  await store.removeItem(toDocStorageKey(loadedAccount, itemId))
  notifyChange(itemId)
}

export async function clearAutomergeDocStore(): Promise<void> {
  entriesByItemId.clear()
  cachedItemSnapshotById.clear()
  loadedAccount = null
  cachedItemsSnapshot = []
  markItemsSnapshotDirty()
  await store.clear()
  notifyAll()
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  for (const item of items) {
    await upsertAutomergeItemSnapshot(item)
  }
}

export async function withAutomergeItemChange(
  itemId: string,
  mutate: (draft: Record<string, unknown>) => void,
): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByItemId.get(itemId)
  const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>({ id: itemId })

  const nextDoc = Automerge.change(baseDoc, draft => {
    mutate(draft as Record<string, unknown>)
    pruneUndefinedDeepInPlace(draft)
  })

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: existing?.syncState || Automerge.initSyncState(),
    cursor: existing?.cursor || 0,
  }

  entriesByItemId.set(itemId, nextEntry)
  await persistEntry(loadedAccount, itemId, nextEntry)
  notifyChange(itemId)
}

export function readAutomergeSyncCursor(itemId: string): number {
  return entriesByItemId.get(itemId)?.cursor || 0
}

export async function writeAutomergeSyncCursor(itemId: string, cursor: number): Promise<void> {
  if (!loadedAccount) {
    return
  }

  const existing = entriesByItemId.get(itemId)
  if (!existing) {
    return
  }

  existing.cursor = Math.max(existing.cursor, cursor)
  await persistEntry(loadedAccount, itemId, existing)
}

export function createAutomergeSyncMessage(itemId: string): { message: Uint8Array | null; nextSyncState: SyncState } | null {
  const entry = entriesByItemId.get(itemId)
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

  const entry = entriesByItemId.get(itemId)
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

  const existing = entriesByItemId.get(itemId)
  const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>({ id: itemId })
  const baseSyncState = existing?.syncState || Automerge.initSyncState()

  const [nextDoc, nextSyncState] = Automerge.receiveSyncMessage(baseDoc, baseSyncState, message)

  const nextEntry: DocEntry = {
    doc: nextDoc,
    syncState: nextSyncState,
    cursor: existing?.cursor || 0,
  }

  entriesByItemId.set(itemId, nextEntry)
  await persistEntry(loadedAccount, itemId, nextEntry)
  notifyChange(itemId)
  return true
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  allListeners.add(listener)

  return () => {
    allListeners.delete(listener)
  }
}

export function subscribeAutomergeItem(itemId: string, listener: (item: Item | null) => void): () => void {
  const listeners = itemListenersById.get(itemId) || new Set<(item: Item | null) => void>()
  listeners.add(listener)
  itemListenersById.set(itemId, listeners)

  return () => {
    const current = itemListenersById.get(itemId)
    if (!current) {
      return
    }

    current.delete(listener)
    if (current.size === 0) {
      itemListenersById.delete(itemId)
    }
  }
}

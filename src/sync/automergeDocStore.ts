import * as Automerge from '@automerge/automerge'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import type { ItemId } from '../shared/itemTypes'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { getAutomergeRepo, getVaultNetworkAdapter, setVaultNetworkAccount } from './automergeRepo'
import {
  clearAutomergeItemIdMappings,
  registerAutomergeItemIds,
  toAutomergeUrlFromItemId,
} from './automergeRepoIds'

export const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

export type SyncStateToken = Uint8Array

export type AutomergeDocumentPatch = {
  op: 'add' | 'replace' | 'remove'
  path: Array<string | number>
  value?: unknown
}

type RepoDoc = Record<string, unknown>

type RepoDocHandle = {
  isReady: () => boolean
  isUnavailable: () => boolean
  whenReady: (awaitStates?: string[]) => Promise<void>
  doc: () => RepoDoc
  change: (callback: (doc: RepoDoc) => void) => void
  on: (event: 'change' | 'delete', listener: (payload?: { doc?: RepoDoc }) => void) => void
  off: (event: 'change' | 'delete', listener: (payload?: { doc?: RepoDoc }) => void) => void
}

type ReceiveSyncResult = {
  changed: boolean
  cursor: number
  serialized: {
    doc: Uint8Array
    syncState: Uint8Array
    cursor: number
  }
}

type UpsertMetadataOptions = {
  markLocalChange?: boolean
}

type EnsureHandleOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

const itemById = new Map<string, Item>()
const itemListeners = new Set<() => void>()
const itemScopedListeners = new Map<string, Set<() => void>>()
const metadataListeners = new Set<() => void>()
const handleByDocumentId = new Map<string, RepoDocHandle>()
const unbindByDocumentId = new Map<string, () => void>()
const syncCursorByItemId = new Map<string, number>()
const localChangeByDocumentId = new Set<string>()

let metadataSnapshot: AccountMetadata = {}
let loadedAccount: string | null = null
let knownIdsUnsubscribe: (() => void) | null = null

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeItemId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

function notifyItemListeners(itemId?: string): void {
  for (const listener of itemListeners) {
    listener()
  }

  if (!itemId) {
    return
  }

  const scoped = itemScopedListeners.get(itemId)
  if (!scoped) {
    return
  }

  for (const listener of scoped) {
    listener()
  }
}

function notifyMetadataListeners(): void {
  for (const listener of metadataListeners) {
    listener()
  }
}

function normalizeMetadataSnapshot(value: unknown): AccountMetadata {
  if (!isPlainObject(value)) {
    return {}
  }

  return deepClone(value) as AccountMetadata
}

function materializeItemSnapshot(itemId: string, doc: RepoDoc): void {
  const normalized = deepClone(doc) as Partial<Item>
  if (typeof normalized.id !== 'string' || normalized.id.length === 0) {
    normalized.id = itemId
  }

  if (typeof normalized.type !== 'string') {
    return
  }

  itemById.set(itemId, normalized as Item)
  notifyItemListeners(itemId)
}

function materializeDocumentSnapshot(documentId: string, doc: RepoDoc): void {
  if (documentId === ACCOUNT_METADATA_DOCUMENT_ID) {
    metadataSnapshot = normalizeMetadataSnapshot(doc)
    notifyMetadataListeners()
    return
  }

  materializeItemSnapshot(documentId, doc)
}

function removeItemSnapshot(itemId: string): void {
  if (!itemById.delete(itemId)) {
    return
  }

  notifyItemListeners(itemId)
}

function detachHandle(documentId: string): void {
  const unbind = unbindByDocumentId.get(documentId)
  if (unbind) {
    unbind()
    unbindByDocumentId.delete(documentId)
  }

  handleByDocumentId.delete(documentId)
}

function bindHandle(documentId: string, handle: RepoDocHandle): void {
  if (unbindByDocumentId.has(documentId)) {
    return
  }

  const onChange = (payload?: { doc?: RepoDoc }) => {
    if (payload?.doc && isPlainObject(payload.doc)) {
      materializeDocumentSnapshot(documentId, payload.doc)
      return
    }

    if (!handle.isReady()) {
      return
    }

    materializeDocumentSnapshot(documentId, handle.doc())
  }

  const onDelete = () => {
    if (documentId === ACCOUNT_METADATA_DOCUMENT_ID) {
      metadataSnapshot = {}
      notifyMetadataListeners()
      return
    }

    removeItemSnapshot(documentId)
  }

  handle.on('change', onChange)
  handle.on('delete', onDelete)

  unbindByDocumentId.set(documentId, () => {
    handle.off('change', onChange)
    handle.off('delete', onDelete)
  })
}

function getPatchParent(root: RepoDoc, path: Array<string | number>): { parent: Record<string | number, unknown>; key: string | number } | null {
  if (path.length === 0) {
    return null
  }

  let current: Record<string | number, unknown> = root

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    const nextKey = path[index + 1]
    const existing = current[key]

    if (existing && typeof existing === 'object') {
      current = existing as Record<string | number, unknown>
      continue
    }

    const replacement = typeof nextKey === 'number' ? [] : {}
    current[key] = replacement
    current = replacement as Record<string | number, unknown>
  }

  return {
    parent: current,
    key: path[path.length - 1],
  }
}

function clonePatchValue(value: unknown): unknown {
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return value
  }

  return deepClone(value)
}

function applyPatch(document: RepoDoc, patch: AutomergeDocumentPatch): void {
  const target = getPatchParent(document, patch.path)
  if (!target) {
    return
  }

  const { parent, key } = target

  if (patch.op === 'remove') {
    if (Array.isArray(parent) && typeof key === 'number') {
      parent.splice(key, 1)
      return
    }

    delete parent[key]
    return
  }

  parent[key] = clonePatchValue(patch.value)
}

async function ensureDocumentHandle(
  documentId: string,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const existing = handleByDocumentId.get(documentId)
  if (existing) {
    return existing
  }

  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)

  let handle = await repo.find<RepoDoc>(documentUrl, {
    allowableStates: ['ready', 'unavailable'],
  }) as unknown as RepoDocHandle

  if (handle.isUnavailable() && options.createIfMissing) {
    const initialValue = options.initialValue || (documentId === ACCOUNT_METADATA_DOCUMENT_ID
      ? {}
      : { id: documentId })

    const binary = Automerge.save(Automerge.from(initialValue))
    handle = repo.import<RepoDoc>(binary, {
      docId: interpretAsDocumentId(documentUrl),
    }) as unknown as RepoDocHandle
  }

  handleByDocumentId.set(documentId, handle)
  bindHandle(documentId, handle)

  if (!handle.isReady()) {
    await handle.whenReady(['ready', 'unavailable'])
  }

  if (handle.isReady()) {
    materializeDocumentSnapshot(documentId, handle.doc())
  }

  return handle
}

async function observeKnownItemIds(itemIds: string[]): Promise<void> {
  const nextIds = new Set(itemIds)

  for (const knownId of Array.from(handleByDocumentId.keys())) {
    if (knownId === ACCOUNT_METADATA_DOCUMENT_ID) {
      continue
    }

    if (nextIds.has(knownId)) {
      continue
    }

    detachHandle(knownId)
    removeItemSnapshot(knownId)
  }

  await Promise.all(itemIds.map(async itemId => {
    await ensureDocumentHandle(itemId)
  }))
}

function ensureKnownIdsSubscription(): void {
  if (knownIdsUnsubscribe) {
    return
  }

  const adapter = getVaultNetworkAdapter()
  knownIdsUnsubscribe = adapter.subscribeKnownItemIds(itemIds => {
    const normalizedItemIds = itemIds.filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)
    registerAutomergeItemIds([ACCOUNT_METADATA_DOCUMENT_ID, ...normalizedItemIds])
    void observeKnownItemIds(normalizedItemIds)
  })
}

function normalizeDocumentIds(itemIds?: string[]): string[] {
  const source = Array.isArray(itemIds) && itemIds.length > 0
    ? itemIds
    : listAutomergeDocumentIds()

  const deduped = new Set<string>()
  for (const rawId of source) {
    const itemId = normalizeItemId(rawId)
    if (!itemId) {
      continue
    }

    deduped.add(itemId)
  }

  return Array.from(deduped)
}

function setLocalChange(documentId: string, changed: boolean): void {
  if (changed) {
    localChangeByDocumentId.add(documentId)
    return
  }

  localChangeByDocumentId.delete(documentId)
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    const chunkSize = 0x8000

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize)
      binary += String.fromCharCode(...chunk)
    }

    return btoa(binary)
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }

  throw new Error('No base64 encoder available')
}

function decodeBase64ToBytes(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const decoded = atob(value)
    const bytes = new Uint8Array(decoded.length)

    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index)
    }

    return bytes
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'))
  }

  throw new Error('No base64 decoder available')
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  const nextAccount = normalizeItemId(account)
  if (!nextAccount) {
    return
  }

  if (loadedAccount !== nextAccount) {
    loadedAccount = nextAccount
    setVaultNetworkAccount(nextAccount)
  }

  ensureKnownIdsSubscription()

  getVaultNetworkAdapter().registerKnownItemIds([ACCOUNT_METADATA_DOCUMENT_ID])
  registerAutomergeItemIds([ACCOUNT_METADATA_DOCUMENT_ID])
  await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
  })

  const knownItemIds = getVaultNetworkAdapter().getKnownItemIds()
  if (knownItemIds.length > 0) {
    await observeKnownItemIds(knownItemIds)
  }
}

export function listAutomergeDocumentIds(): string[] {
  const itemIds = listAutomergeItemIds()
  return [
    ACCOUNT_METADATA_DOCUMENT_ID,
    ...itemIds,
  ]
}

export function filterAutomergeLocallyChangedDocumentIds(itemIds: string[]): string[] {
  const normalized = normalizeDocumentIds(itemIds)
  const dirty = normalized.filter(itemId => localChangeByDocumentId.has(itemId))
  return dirty.length > 0 ? dirty : normalized
}

export function hasAutomergeDocument(documentId: string): boolean {
  if (documentId === ACCOUNT_METADATA_DOCUMENT_ID) {
    return true
  }

  return itemById.has(documentId)
    || getVaultNetworkAdapter().getKnownItemIds().includes(documentId)
}

export function listAutomergeItemIds(): string[] {
  const ids = new Set<string>([
    ...getVaultNetworkAdapter().getKnownItemIds(),
    ...Array.from(itemById.keys()),
  ])

  return Array.from(ids).filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)
}

export function invalidateCachedItems(itemIds: string[]): void {
  getVaultNetworkAdapter().syncItemIds(itemIds)
}

export function getAutomergeItems(): Item[] {
  return Array.from(itemById.values())
}

export function getAutomergeItemIds(): string[] {
  return listAutomergeItemIds()
}

export function getAutomergeItem(itemId: string): Item | null {
  return itemById.get(itemId) || null
}

export function getAutomergeMetadata(): AccountMetadata {
  return metadataSnapshot
}

export async function seedAutomergeDocument(
  documentId: string,
  binary: Uint8Array,
): Promise<void> {
  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)

  const handle = repo.import<RepoDoc>(binary, {
    docId: interpretAsDocumentId(documentUrl),
  }) as unknown as RepoDocHandle

  handleByDocumentId.set(documentId, handle)
  bindHandle(documentId, handle)

  if (!handle.isReady()) {
    await handle.whenReady(['ready', 'unavailable'])
  }

  if (handle.isReady()) {
    materializeDocumentSnapshot(documentId, handle.doc())
  }

  if (documentId !== ACCOUNT_METADATA_DOCUMENT_ID) {
    registerAutomergeItemIds([documentId])
    getVaultNetworkAdapter().registerKnownItemIds([documentId])
  }
}

export async function upsertAutomergeMetadataSnapshot(
  metadata: AccountMetadata,
  options: UpsertMetadataOptions = {},
): Promise<void> {
  const handle = await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
  })

  const nextMetadata = deepClone(metadata || {})
  handle.change(doc => {
    for (const key of Object.keys(doc)) {
      if (!(key in nextMetadata) || nextMetadata[key as keyof AccountMetadata] === undefined) {
        delete doc[key]
      }
    }

    for (const [key, value] of Object.entries(nextMetadata)) {
      if (value !== undefined) {
        doc[key] = value
      }
    }
  })

  setLocalChange(ACCOUNT_METADATA_DOCUMENT_ID, options.markLocalChange !== false)
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return
  }

  detachHandle(normalizedItemId)
  removeItemSnapshot(normalizedItemId)
  localChangeByDocumentId.delete(normalizedItemId)
  syncCursorByItemId.delete(normalizedItemId)

  getVaultNetworkAdapter().removeKnownItemIds([normalizedItemId])

  try {
    getAutomergeRepo().delete(toAutomergeUrlFromItemId(normalizedItemId))
  } catch {
    // Ignore missing local handles.
  }
}

export async function clearAutomergeDocStore(): Promise<void> {
  const documentIds = listAutomergeDocumentIds()

  for (const documentId of documentIds) {
    try {
      getAutomergeRepo().delete(toAutomergeUrlFromItemId(documentId))
    } catch {
      // Ignore missing local handles.
    }

    if (documentId !== ACCOUNT_METADATA_DOCUMENT_ID) {
      detachHandle(documentId)
    }
  }

  detachHandle(ACCOUNT_METADATA_DOCUMENT_ID)

  itemById.clear()
  metadataSnapshot = {}
  syncCursorByItemId.clear()
  localChangeByDocumentId.clear()

  getVaultNetworkAdapter().clearKnownItemIds()
  clearAutomergeItemIdMappings()

  if (typeof indexedDB !== 'undefined') {
    try {
      indexedDB.deleteDatabase('flock-automerge-db')
    } catch {
      // Ignore IndexedDB delete failures in constrained environments.
    }
  }

  notifyItemListeners()
  notifyMetadataListeners()
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  await Promise.all(items.map(async item => {
    const normalized = deepClone(item) as unknown as RepoDoc
    const binary = Automerge.save(Automerge.from(normalized))
    await seedAutomergeDocument(item.id, binary)
  }))
}

export async function exportAllBinaries(): Promise<Partial<Record<ItemId, string>>> {
  const exported: Partial<Record<ItemId, string>> = {}

  for (const documentId of listAutomergeDocumentIds()) {
    const handle = await ensureDocumentHandle(documentId)
    if (!handle.isReady()) {
      continue
    }

    const binary = Automerge.save(handle.doc())
    exported[documentId as ItemId] = encodeBytesToBase64(binary)
  }

  return exported
}

export async function restoreFromBinaries(documents: Partial<Record<ItemId, string>>): Promise<string[]> {
  const restoredItemIds: string[] = []

  for (const [documentId, encodedBinary] of Object.entries(documents)) {
    if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) {
      continue
    }

    await seedAutomergeDocument(documentId, decodeBase64ToBytes(encodedBinary))

    if (documentId !== ACCOUNT_METADATA_DOCUMENT_ID) {
      restoredItemIds.push(documentId)
    }
  }

  if (restoredItemIds.length > 0) {
    getVaultNetworkAdapter().syncItemIds(restoredItemIds)
  }

  return restoredItemIds
}

export async function applyAutomergeItemPatches(
  itemId: string,
  patches: AutomergeDocumentPatch[],
): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId || patches.length === 0) {
    return
  }

  registerAutomergeItemIds([normalizedItemId])
  getVaultNetworkAdapter().registerKnownItemIds([normalizedItemId])

  const handle = await ensureDocumentHandle(normalizedItemId, {
    createIfMissing: true,
    initialValue: {
      id: normalizedItemId,
    },
  })

  handle.change(doc => {
    for (const patch of patches) {
      applyPatch(doc, patch)
    }

    if (typeof doc.id !== 'string' || doc.id.length === 0) {
      doc.id = normalizedItemId
    }
  })

  setLocalChange(normalizedItemId, true)
}

export async function applyAutomergeMetadataPatches(
  patches: AutomergeDocumentPatch[],
): Promise<void> {
  if (patches.length === 0) {
    return
  }

  const handle = await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
  })

  handle.change(doc => {
    for (const patch of patches) {
      applyPatch(doc, patch)
    }
  })

  setLocalChange(ACCOUNT_METADATA_DOCUMENT_ID, true)
}

export function readAutomergeSyncCursor(itemId: string): number {
  return syncCursorByItemId.get(itemId) || 0
}

export async function writeAutomergeSyncCursor(itemId: string, cursor: number): Promise<void> {
  if (!Number.isFinite(cursor)) {
    return
  }

  syncCursorByItemId.set(itemId, Math.max(0, Math.floor(cursor)))
}

export async function createAutomergeSyncMessage(
  itemId: string,
): Promise<{ message: Uint8Array | null; nextSyncState: SyncStateToken } | null> {
  if (!localChangeByDocumentId.has(itemId)) {
    return null
  }

  return {
    message: null,
    nextSyncState: new Uint8Array(),
  }
}

export async function commitAutomergeSyncState(itemId: string, _: SyncStateToken): Promise<void> {
  setLocalChange(itemId, false)
}

export async function receiveAutomergeSyncMessage(
  itemId: string,
  _message: Uint8Array,
  cursor?: number,
): Promise<ReceiveSyncResult> {
  const nextCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor as number)) : readAutomergeSyncCursor(itemId)
  syncCursorByItemId.set(itemId, nextCursor)

  getVaultNetworkAdapter().registerKnownItemIds([itemId])
  getVaultNetworkAdapter().syncItemIds([itemId])

  return {
    changed: false,
    cursor: nextCursor,
    serialized: {
      doc: new Uint8Array(),
      syncState: new Uint8Array(),
      cursor: nextCursor,
    },
  }
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  itemListeners.add(listener)
  return () => {
    itemListeners.delete(listener)
  }
}

export function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
  const scoped = itemScopedListeners.get(itemId) || new Set<() => void>()
  scoped.add(listener)
  itemScopedListeners.set(itemId, scoped)

  return () => {
    const listeners = itemScopedListeners.get(itemId)
    if (!listeners) {
      return
    }

    listeners.delete(listener)
    if (listeners.size === 0) {
      itemScopedListeners.delete(itemId)
    }
  }
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  metadataListeners.add(listener)
  return () => {
    metadataListeners.delete(listener)
  }
}

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

type SyncStateToken = Uint8Array

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

const handleByDocumentId = new Map<string, RepoDocHandle>()
const syncCursorByItemId = new Map<string, number>()
const localChangeByDocumentId = new Set<string>()

let loadedAccount: string | null = null
let knownIdsUnsubscribe: (() => void) | null = null

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeItemId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null
  }

  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function evictDocumentHandle(documentId: string): Promise<void> {
  handleByDocumentId.delete(documentId)

  try {
    await getAutomergeRepo().removeFromCache(interpretAsDocumentId(toAutomergeUrlFromItemId(documentId)))
  } catch {
    // Ignore cache-eviction failures for handles that were never loaded.
  }
}

function setLocalChange(documentId: string, changed: boolean): void {
  if (changed) {
    localChangeByDocumentId.add(documentId)
    return
  }

  localChangeByDocumentId.delete(documentId)
}

function snapshotFromHandle(handle: RepoDocHandle): RepoDoc | null {
  if (!handle.isReady()) {
    return null
  }

  try {
    const doc = handle.doc()
    return isPlainObject(doc) ? cloneValue(doc) : null
  } catch {
    return null
  }
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

  if (!handle.isReady()) {
    await handle.whenReady(['ready', 'unavailable'])
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

    await evictDocumentHandle(knownId)
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

function encodeBytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index])
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

  return cloneValue(value)
}

function applyPatch(document: RepoDoc, patch: AutomergeDocumentPatch): void {
  const target = getPatchParent(document, patch.path)
  if (!target) {
    return
  }

  const { parent, key } = target

  if (patch.op === 'remove') {
    if (Array.isArray(parent) && typeof key === 'number') {
      delete parent[key]
      return
    }

    delete parent[key]
    return
  }

  parent[key] = clonePatchValue(patch.value)
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

  return handleByDocumentId.has(documentId)
    || getVaultNetworkAdapter().getKnownItemIds().includes(documentId)
}

export function listAutomergeItemIds(): string[] {
  const ids = new Set<string>([
    ...getVaultNetworkAdapter().getKnownItemIds(),
    ...Array.from(handleByDocumentId.keys()).filter(documentId => documentId !== ACCOUNT_METADATA_DOCUMENT_ID),
  ])

  return Array.from(ids).filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)
}

export function invalidateCachedItems(itemIds: string[]): void {
  getVaultNetworkAdapter().syncItemIds(itemIds)
}

export function getAutomergeItems(): Item[] {
  const items: Item[] = []

  for (const itemId of listAutomergeItemIds()) {
    const item = getAutomergeItem(itemId)
    if (item) {
      items.push(item)
    }
  }

  return items
}

export function getAutomergeItem(itemId: string): Item | null {
  const handle = handleByDocumentId.get(itemId)
  if (!handle) {
    return null
  }

  const snapshot = snapshotFromHandle(handle)
  if (!snapshot) {
    return null
  }

  const item = snapshot as Partial<Item>
  if (typeof item.id !== 'string' || item.id.length === 0) {
    item.id = itemId
  }

  if (typeof item.type !== 'string' || item.type.length === 0) {
    return null
  }

  return item as Item
}

export function getAutomergeMetadata(): AccountMetadata {
  const handle = handleByDocumentId.get(ACCOUNT_METADATA_DOCUMENT_ID)
  if (!handle) {
    return {}
  }

  const snapshot = snapshotFromHandle(handle)
  if (!snapshot || !isPlainObject(snapshot)) {
    return {}
  }

  return snapshot as AccountMetadata
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

  if (!handle.isReady()) {
    await handle.whenReady(['ready', 'unavailable'])
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

  const nextMetadata = cloneValue(metadata || {})
  handle.change(doc => {
    for (const key of Object.keys(doc)) {
      if (!(key in nextMetadata) || nextMetadata[key as keyof AccountMetadata] === undefined) {
        delete doc[key]
      }
    }

    for (const [key, value] of Object.entries(nextMetadata)) {
      doc[key] = value
    }
  })

  setLocalChange(ACCOUNT_METADATA_DOCUMENT_ID, options.markLocalChange !== false)
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return
  }

  localChangeByDocumentId.delete(normalizedItemId)
  syncCursorByItemId.delete(normalizedItemId)

  getVaultNetworkAdapter().removeKnownItemIds([normalizedItemId])

  await evictDocumentHandle(normalizedItemId)

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

    await evictDocumentHandle(documentId)
  }

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
}

export async function seedAutomergeItems(items: Item[]): Promise<void> {
  await Promise.all(items.map(async item => {
    const normalized = cloneValue(item) as unknown as RepoDoc
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
  const nextCursor = Number.isFinite(cursor)
    ? Math.max(0, Math.floor(cursor as number))
    : readAutomergeSyncCursor(itemId)
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
  const adapter = getVaultNetworkAdapter()
  const unbindByItemId = new Map<string, () => void>()
  let disposed = false

  const attachItemHandle = async (itemId: string): Promise<void> => {
    if (disposed || unbindByItemId.has(itemId)) {
      return
    }

    const handle = await ensureDocumentHandle(itemId).catch(() => null)
    if (disposed || !handle) {
      return
    }

    const onChange = () => {
      listener()
    }

    handle.on('change', onChange)
    handle.on('delete', onChange)
    unbindByItemId.set(itemId, () => {
      handle.off('change', onChange)
      handle.off('delete', onChange)
    })
  }

  const unsubscribeKnownIds = adapter.subscribeKnownItemIds(itemIds => {
    const normalized = itemIds.filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)
    const nextIds = new Set(normalized)

    for (const [existingItemId, unbind] of unbindByItemId) {
      if (nextIds.has(existingItemId)) {
        continue
      }

      unbind()
      unbindByItemId.delete(existingItemId)
    }

    for (const itemId of normalized) {
      void attachItemHandle(itemId)
    }

    listener()
  })

  return () => {
    disposed = true
    unsubscribeKnownIds()

    for (const unbind of unbindByItemId.values()) {
      unbind()
    }

    unbindByItemId.clear()
  }
}

export function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
  let disposed = false
  let unbind = () => undefined

  void ensureDocumentHandle(itemId).then(handle => {
    if (disposed) {
      return
    }

    const onChange = () => {
      listener()
    }

    handle.on('change', onChange)
    handle.on('delete', onChange)
    unbind = () => {
      handle.off('change', onChange)
      handle.off('delete', onChange)
    }
  }).catch(() => undefined)

  return () => {
    disposed = true
    unbind()
  }
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  let disposed = false
  let unbind = () => undefined

  void ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
  }).then(handle => {
    if (disposed) {
      return
    }

    const onChange = () => {
      listener()
    }

    handle.on('change', onChange)
    handle.on('delete', onChange)
    unbind = () => {
      handle.off('change', onChange)
      handle.off('delete', onChange)
    }
  }).catch(() => undefined)

  return () => {
    disposed = true
    unbind()
  }
}

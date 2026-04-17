import * as Automerge from '@automerge/automerge'
import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import type { ItemId } from '../shared/itemTypes'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { getAutomergeRepo } from './automergeRepo'
import {
  clearAutomergeItemIdMappings,
  registerAutomergeItemIds,
  toAutomergeUrlFromItemId,
} from './automergeRepoIds'
import { decodeBase64ToBytes, encodeBytesToBase64 } from './utils/base64Utils'
import { applyDocumentPatch } from './utils/documentPatchUtils'

export const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

export type AutomergeDocumentPatch = {
  op: 'add' | 'replace' | 'remove'
  path: Array<string | number>
  value?: unknown
}

type RepoDoc = Record<string, unknown>

type RepoDocHandle = DocHandle<RepoDoc>

type UpsertMetadataOptions = {
  markLocalChange?: boolean
}

type EnsureHandleOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
  awaitReady?: boolean
}

type HandleSubscription = {
  handle: RepoDocHandle
  onChange: () => void
  onDelete: () => void
}

type SnapshotScope = 'item' | 'items' | 'metadata'

const handleByDocumentId = new Map<string, RepoDocHandle>()
const handleSubscriptionByDocumentId = new Map<string, HandleSubscription>()
const syncCursorByItemId = new Map<string, number>()
const localChangeByDocumentId = new Set<string>()
const automergeSnapshotListeners = new Set<() => void>()
const automergeItemListenersById = new Map<string, Set<() => void>>()
const automergeItemsListeners = new Set<() => void>()
const automergeMetadataListeners = new Set<() => void>()
const knownItemIds = new Set<string>()

let automergeSnapshotNotifyQueued = false
const pendingSnapshotScopes = new Set<SnapshotScope>()
const pendingSnapshotItemIds = new Set<string>()

function flushAutomergeSnapshotChanged(): void {
  automergeSnapshotNotifyQueued = false

  const snapshotListeners = Array.from(automergeSnapshotListeners)
  const itemsListeners = pendingSnapshotScopes.has('items')
    ? Array.from(automergeItemsListeners)
    : []
  const metadataListeners = pendingSnapshotScopes.has('metadata')
    ? Array.from(automergeMetadataListeners)
    : []

  const itemListenersById = Array.from(pendingSnapshotItemIds).map(itemId => [
    itemId,
    Array.from(automergeItemListenersById.get(itemId) || []),
  ] as const)

  pendingSnapshotScopes.clear()
  pendingSnapshotItemIds.clear()

  for (const listener of snapshotListeners) {
    listener()
  }

  for (const listener of itemsListeners) {
    listener()
  }

  for (const listener of metadataListeners) {
    listener()
  }

  for (const [, listeners] of itemListenersById) {
    for (const listener of listeners) {
      listener()
    }
  }
}

function notifyAutomergeSnapshotChanged(scope: SnapshotScope, itemId?: string): void {
  pendingSnapshotScopes.add(scope)

  if (itemId) {
    pendingSnapshotItemIds.add(itemId)
  }

  if (automergeSnapshotNotifyQueued) {
    return
  }

  automergeSnapshotNotifyQueued = true
  queueMicrotask(flushAutomergeSnapshotChanged)
}

export function subscribeAutomergeSnapshots(listener: () => void): () => void {
  automergeSnapshotListeners.add(listener)

  return () => {
    automergeSnapshotListeners.delete(listener)
  }
}

export function subscribeAutomergeItems(listener: () => void): () => void {
  automergeItemsListeners.add(listener)

  return () => {
    automergeItemsListeners.delete(listener)
  }
}

export function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return () => undefined
  }

  const listeners = automergeItemListenersById.get(normalizedItemId) || new Set<() => void>()
  listeners.add(listener)
  automergeItemListenersById.set(normalizedItemId, listeners)

  return () => {
    const next = automergeItemListenersById.get(normalizedItemId)
    if (!next) {
      return
    }

    next.delete(listener)
    if (next.size === 0) {
      automergeItemListenersById.delete(normalizedItemId)
    }
  }
}

export function subscribeAutomergeMetadata(listener: () => void): () => void {
  automergeMetadataListeners.add(listener)

  return () => {
    automergeMetadataListeners.delete(listener)
  }
}

function getSnapshotScopeForDocumentId(documentId: string): SnapshotScope {
  return documentId === ACCOUNT_METADATA_DOCUMENT_ID ? 'metadata' : 'items'
}

function notifyDocumentSnapshotChanged(documentId: string): void {
  const scope = getSnapshotScopeForDocumentId(documentId)

  if (scope === 'items') {
    notifyAutomergeSnapshotChanged(scope, documentId)
    return
  }

  notifyAutomergeSnapshotChanged(scope)
}

function notifyAllSnapshotScopesChanged(): void {
  notifyAutomergeSnapshotChanged('metadata')
  notifyAutomergeSnapshotChanged('items')
}

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

function removeHandleSubscription(documentId: string): void {
  const existing = handleSubscriptionByDocumentId.get(documentId)
  if (!existing) {
    return
  }

  existing.handle.off('change', existing.onChange)
  existing.handle.off('delete', existing.onDelete)
  handleSubscriptionByDocumentId.delete(documentId)
}

function ensureHandleSubscription(documentId: string, handle: RepoDocHandle): void {
  const existing = handleSubscriptionByDocumentId.get(documentId)
  if (existing?.handle === handle) {
    return
  }

  if (existing) {
    removeHandleSubscription(documentId)
  }

  const onChange = () => {
    notifyDocumentSnapshotChanged(documentId)
  }

  const onDelete = () => {
    handleByDocumentId.delete(documentId)
    syncCursorByItemId.delete(documentId)
    localChangeByDocumentId.delete(documentId)
    removeHandleSubscription(documentId)
    notifyDocumentSnapshotChanged(documentId)
  }

  handle.on('change', onChange)
  handle.on('delete', onDelete)
  handleSubscriptionByDocumentId.set(documentId, {
    handle,
    onChange,
    onDelete,
  })
}

function tryResolveNonReadyHandle(handle: RepoDocHandle): void {
  if (handle.isReady() || handle.isUnavailable()) {
    return
  }

  try {
    handle.doneLoading()
  } catch {
    // Ignore and keep the handle in its current state.
  }
}

export function resolvePendingAutomergeHandles(): void {
  const repoHandles = Object.values(getAutomergeRepo().handles || {}) as Array<RepoDocHandle & {
    isDeleted?: () => boolean
    isUnloaded?: () => boolean
  }>

  for (const handle of repoHandles) {
    if (handle.isReady() || handle.isUnavailable()) {
      continue
    }

    if (handle.isDeleted?.() || handle.isUnloaded?.()) {
      continue
    }

    tryResolveNonReadyHandle(handle)
  }
}

async function evictDocumentHandle(documentId: string): Promise<void> {
  handleByDocumentId.delete(documentId)
  removeHandleSubscription(documentId)

  try {
    await getAutomergeRepo().removeFromCache(interpretAsDocumentId(toAutomergeUrlFromItemId(documentId)))
  } catch {
    // Ignore cache-eviction failures for handles that were never loaded.
  }

  notifyDocumentSnapshotChanged(documentId)
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
    return isPlainObject(doc) ? (doc as RepoDoc) : null
  } catch {
    return null
  }
}

async function ensureDocumentHandle(
  documentId: string,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  let handle = repo.findWithProgress<RepoDoc>(documentUrl).handle as RepoDocHandle

  if (options.awaitReady === false) {
    tryResolveNonReadyHandle(handle)
  }

  if (options.awaitReady !== false && !handle.isReady() && !handle.isUnavailable()) {
    await handle.whenReady(['ready', 'unavailable'])
  }

  if (handle.isUnavailable() && options.createIfMissing) {
    // Deleting clears the unavailable handle so import can recreate this doc id.
    try {
      repo.delete(resolvedDocumentId)
    } catch (error) {
      console.error('[automerge] failed to clear unavailable handle before import', {
        documentId,
        error,
      })
    }

    const initialValue = options.initialValue || (documentId === ACCOUNT_METADATA_DOCUMENT_ID
      ? {}
      : { id: documentId })

    const binary = Automerge.save(Automerge.from(initialValue))
    handle = repo.import<RepoDoc>(binary, {
      docId: resolvedDocumentId,
    }) as RepoDocHandle

    if (options.awaitReady === false) {
      tryResolveNonReadyHandle(handle)
    }

    if (options.awaitReady !== false && !handle.isReady() && !handle.isUnavailable()) {
      await handle.whenReady(['ready', 'unavailable'])
    }
  }

  handleByDocumentId.set(documentId, handle)
  ensureHandleSubscription(documentId, handle)
  notifyDocumentSnapshotChanged(documentId)

  return handle
}

export async function observeAutomergeKnownItemIds(itemIds: string[]): Promise<void> {
  const normalizedItemIds: string[] = []
  const normalizedItemIdSet = new Set<string>()

  for (const rawItemId of itemIds) {
    const normalizedItemId = normalizeItemId(rawItemId)
    if (!normalizedItemId || normalizedItemId === ACCOUNT_METADATA_DOCUMENT_ID || normalizedItemIdSet.has(normalizedItemId)) {
      continue
    }

    normalizedItemIdSet.add(normalizedItemId)
    normalizedItemIds.push(normalizedItemId)
  }

  knownItemIds.clear()
  for (const itemId of normalizedItemIds) {
    knownItemIds.add(itemId)
  }

  const nextIds = new Set(normalizedItemIds)

  for (const knownId of Array.from(handleByDocumentId.keys())) {
    if (knownId === ACCOUNT_METADATA_DOCUMENT_ID) {
      continue
    }

    if (nextIds.has(knownId)) {
      continue
    }

    await evictDocumentHandle(knownId)
  }

  await Promise.all(normalizedItemIds.map(async itemId => {
    try {
      await ensureDocumentHandle(itemId, { awaitReady: false })
    } catch (error) {
      console.error('[automerge] failed to observe known item id handle', { itemId, error })
    }
  }))

  notifyAutomergeSnapshotChanged('items')
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  const nextAccount = normalizeItemId(account)
  if (!nextAccount) {
    return
  }

  resolvePendingAutomergeHandles()

  registerAutomergeItemIds([ACCOUNT_METADATA_DOCUMENT_ID])

  await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
    awaitReady: false,
  })
}

export function listAutomergeDocumentIds(): string[] {
  const itemIds = listAutomergeItemIds()
  return [
    ACCOUNT_METADATA_DOCUMENT_ID,
    ...itemIds,
  ]
}

export function listAutomergeItemIds(): string[] {
  const ids = new Set<string>([
    ...Array.from(knownItemIds),
    ...Array.from(handleByDocumentId.keys()).filter(documentId => documentId !== ACCOUNT_METADATA_DOCUMENT_ID),
  ])

  return Array.from(ids).filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)
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
  const normalizedItem = (typeof item.id === 'string' && item.id.length > 0)
    ? item
    : { ...item, id: itemId }

  if (typeof normalizedItem.type !== 'string' || normalizedItem.type.length === 0) {
    return null
  }

  return normalizedItem as Item
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

async function seedAutomergeDocument(
  documentId: string,
  binary: Uint8Array,
): Promise<void> {
  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)

  const handle = repo.import<RepoDoc>(binary, {
    docId: interpretAsDocumentId(documentUrl),
  }) as unknown as RepoDocHandle

  handleByDocumentId.set(documentId, handle)
  ensureHandleSubscription(documentId, handle)
  notifyDocumentSnapshotChanged(documentId)

  if (!handle.isReady() && !handle.isUnavailable()) {
    try {
      handle.doneLoading()
    } catch {
      // Ignore doneLoading errors and fall back to whenReady.
    }
  }

  if (!handle.isReady() && !handle.isUnavailable()) {
    await handle.whenReady(['ready', 'unavailable'])
  }

  if (documentId !== ACCOUNT_METADATA_DOCUMENT_ID) {
    registerAutomergeItemIds([documentId])
  }
}

export async function hydrateAutomergeDocumentBinary(
  documentId: string,
  binary: Uint8Array,
): Promise<void> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
    return
  }

  await seedAutomergeDocument(normalizedDocumentId, binary)
}

export async function upsertAutomergeMetadataSnapshot(
  metadata: AccountMetadata,
  options: UpsertMetadataOptions = {},
): Promise<void> {
  const handle = await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
    awaitReady: false,
  })

  if (!handle.isReady()) {
    return
  }

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

  knownItemIds.delete(normalizedItemId)
  localChangeByDocumentId.delete(normalizedItemId)
  syncCursorByItemId.delete(normalizedItemId)

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

  for (const documentId of Array.from(handleSubscriptionByDocumentId.keys())) {
    removeHandleSubscription(documentId)
  }

  syncCursorByItemId.clear()
  localChangeByDocumentId.clear()
  knownItemIds.clear()
  clearAutomergeItemIdMappings()

  if (typeof indexedDB !== 'undefined') {
    try {
      indexedDB.deleteDatabase('flock-automerge-db')
    } catch {
      // Ignore IndexedDB delete failures in constrained environments.
    }
  }

  notifyAllSnapshotScopesChanged()
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

  const handle = await ensureDocumentHandle(normalizedItemId, {
    createIfMissing: true,
    initialValue: {
      id: normalizedItemId,
    },
    awaitReady: false,
  })

  if (handle.isUnavailable()) {
    return
  }

  if (!handle.isReady()) {
    return
  }

  handle.change(doc => {
    for (const patch of patches) {
      applyDocumentPatch(doc, patch)
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
    awaitReady: false,
  })

  if (!handle.isReady()) {
    return
  }

  handle.change(doc => {
    for (const patch of patches) {
      applyDocumentPatch(doc, patch)
    }
  })

  setLocalChange(ACCOUNT_METADATA_DOCUMENT_ID, true)
}

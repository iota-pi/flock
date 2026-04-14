import * as Automerge from '@automerge/automerge'
import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
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

const handleByDocumentId = new Map<string, RepoDocHandle>()
const inFlightHandleByDocumentId = new Map<string, Promise<RepoDocHandle>>()
const handleSubscriptionByDocumentId = new Map<string, HandleSubscription>()
const syncCursorByItemId = new Map<string, number>()
const localChangeByDocumentId = new Set<string>()
const automergeSnapshotListeners = new Set<() => void>()

let loadedAccount: string | null = null
let knownIdsUnsubscribe: (() => void) | null = null
let automergeSnapshotVersion = 0
let automergeSnapshotNotifyQueued = false

function flushAutomergeSnapshotChanged(): void {
  automergeSnapshotNotifyQueued = false
  automergeSnapshotVersion += 1
  for (const listener of Array.from(automergeSnapshotListeners)) {
    listener()
  }
}

function notifyAutomergeSnapshotChanged(): void {
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

export function getAutomergeSnapshotVersion(): number {
  return automergeSnapshotVersion
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
    notifyAutomergeSnapshotChanged()
  }

  const onDelete = () => {
    handleByDocumentId.delete(documentId)
    syncCursorByItemId.delete(documentId)
    localChangeByDocumentId.delete(documentId)
    removeHandleSubscription(documentId)
    if (documentId !== ACCOUNT_METADATA_DOCUMENT_ID) {
      getVaultNetworkAdapter().removeKnownItemIds([documentId])
    }
    notifyAutomergeSnapshotChanged()
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

  notifyAutomergeSnapshotChanged()
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
    if (options.awaitReady === false) {
      tryResolveNonReadyHandle(existing)
    }

    ensureHandleSubscription(documentId, existing)

    if (options.awaitReady !== false && !existing.isReady() && !existing.isUnavailable()) {
      await existing.whenReady(['ready', 'unavailable'])
    }

    if (options.createIfMissing && existing.isUnavailable()) {
      handleByDocumentId.delete(documentId)
    } else {
      return existing
    }
  }

  const refreshedExisting = handleByDocumentId.get(documentId)
  if (refreshedExisting) {
    ensureHandleSubscription(documentId, refreshedExisting)
    return refreshedExisting
  }

  const inFlight = inFlightHandleByDocumentId.get(documentId)
  if (inFlight) {
    const inFlightHandle = await inFlight

    if (options.awaitReady === false) {
      tryResolveNonReadyHandle(inFlightHandle)
    }

    if (options.awaitReady !== false && !inFlightHandle.isReady() && !inFlightHandle.isUnavailable()) {
      await inFlightHandle.whenReady(['ready', 'unavailable'])
    }

    if (options.createIfMissing && inFlightHandle.isUnavailable()) {
      handleByDocumentId.delete(documentId)
      inFlightHandleByDocumentId.delete(documentId)
    } else {
      ensureHandleSubscription(documentId, inFlightHandle)
      return inFlightHandle
    }
  }

  const operation = (async () => {
    const repo = getAutomergeRepo()
    const documentUrl = toAutomergeUrlFromItemId(documentId)
    const resolvedDocumentId = interpretAsDocumentId(documentUrl)

    const progress = repo.findWithProgress<RepoDoc>(documentUrl)
    let handle = progress.handle as RepoDocHandle

    if (options.awaitReady === false) {
      tryResolveNonReadyHandle(handle)
    }

    if (options.awaitReady !== false && !handle.isReady() && !handle.isUnavailable()) {
      await handle.whenReady(['ready', 'unavailable'])
    }

    if (handle.isUnavailable() && options.createIfMissing) {
      // `removeFromCache` can throw for unavailable handles in current automerge-repo.
      // Deleting clears the cached unavailable handle so import can recreate this doc id.
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
    notifyAutomergeSnapshotChanged()
    return handle
  })()

  inFlightHandleByDocumentId.set(documentId, operation)

  try {
    return await operation
  } finally {
    inFlightHandleByDocumentId.delete(documentId)
  }
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
    try {
      await ensureDocumentHandle(itemId, { awaitReady: false })
    } catch (error) {
      console.error('[automerge] failed to observe known item id handle', { itemId, error })
    }
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
    notifyAutomergeSnapshotChanged()
    void observeKnownItemIds(normalizedItemIds)
  })
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

  resolvePendingAutomergeHandles()

  ensureKnownIdsSubscription()

  getVaultNetworkAdapter().registerKnownItemIds([ACCOUNT_METADATA_DOCUMENT_ID])
  registerAutomergeItemIds([ACCOUNT_METADATA_DOCUMENT_ID])

  await ensureDocumentHandle(ACCOUNT_METADATA_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue: {},
    awaitReady: false,
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

export function listAutomergeItemIds(): string[] {
  const ids = new Set<string>([
    ...getVaultNetworkAdapter().getKnownItemIds(),
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
  notifyAutomergeSnapshotChanged()

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
    getVaultNetworkAdapter().registerKnownItemIds([documentId])
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

  localChangeByDocumentId.delete(normalizedItemId)
  syncCursorByItemId.delete(normalizedItemId)

  getVaultNetworkAdapter().removeKnownItemIds([normalizedItemId])

  await evictDocumentHandle(normalizedItemId)

  try {
    getAutomergeRepo().delete(toAutomergeUrlFromItemId(normalizedItemId))
  } catch {
    // Ignore missing local handles.
  }

  notifyAutomergeSnapshotChanged()
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

  getVaultNetworkAdapter().clearKnownItemIds()
  clearAutomergeItemIdMappings()

  if (typeof indexedDB !== 'undefined') {
    try {
      indexedDB.deleteDatabase('flock-automerge-db')
    } catch {
      // Ignore IndexedDB delete failures in constrained environments.
    }
  }

  notifyAutomergeSnapshotChanged()
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
    awaitReady: false,
  })

  if (!handle.isReady()) {
    return
  }

  handle.change(doc => {
    for (const patch of patches) {
      applyPatch(doc, patch)
    }
  })

  setLocalChange(ACCOUNT_METADATA_DOCUMENT_ID, true)
}

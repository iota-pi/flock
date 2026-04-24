import * as Automerge from '@automerge/automerge'
import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import type { ItemId } from '../shared/itemTypes'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { getAutomergeRepo } from './automergeRepo'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { decodeBase64ToBytes, encodeBytesToBase64 } from './utils/base64Utils'
import {
  ACCOUNT_INDEX_DOCUMENT_ID,
  LEGACY_ACCOUNT_METADATA_DOCUMENT_ID,
} from './automergeConstants'
import {
  awaitHandleReadyIfNeeded,
  findRepoDocHandle,
  readReadyObjectSnapshot,
  tryResolveNonReadyHandle,
} from './automergeHandleUtils'

export const ACCOUNT_METADATA_DOCUMENT_ID = ACCOUNT_INDEX_DOCUMENT_ID

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: string[]
  metadata?: AccountMetadata
}

type RepoDoc = Record<string, unknown>
type RepoDocHandle = DocHandle<RepoDoc> | undefined

type EnsureHandleOptions = {
  awaitReady?: boolean
} & (
  | { createIfMissing?: false | undefined; initialValue?: never }
  | { createIfMissing: true; initialValue: RepoDoc }
)

type ChangeDocumentOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
  addToIndex?: boolean
}

type UpsertMetadataOptions = {
  markLocalChange?: boolean
}

const initializedAccounts = new Set<string>()

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

function normalizeItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const deduped = new Set<string>()

  for (const entry of raw) {
    const normalized = normalizeItemId(entry)
    if (!normalized) {
      continue
    }

    if (
      normalized === ACCOUNT_INDEX_DOCUMENT_ID
      || normalized === LEGACY_ACCOUNT_METADATA_DOCUMENT_ID
      || deduped.has(normalized)
    ) {
      continue
    }

    deduped.add(normalized)
  }

  return Array.from(deduped)
}

function normalizeMetadata(raw: unknown): AccountMetadata {
  return isPlainObject(raw) ? (raw as AccountMetadata) : {}
}

function hasAnyKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

function getRepoHandle(documentId: string): RepoDocHandle {
  const documentUrl = toAutomergeUrlFromItemId(documentId)
  return findRepoDocHandle<RepoDoc>(getAutomergeRepo(), documentUrl)
}

async function ensureDocumentHandle(
  documentId: string,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  let handle = findRepoDocHandle<RepoDoc>(repo, documentUrl)

  if (options.awaitReady === false) {
    tryResolveNonReadyHandle(handle)
  }

  if (options.awaitReady !== false) {
    await awaitHandleReadyIfNeeded(handle)
  }

  if ((handle?.isUnavailable() || !handle) && options.createIfMissing) {
    try {
      repo.delete(resolvedDocumentId)
    } catch (error) {
      console.error('[automerge] failed to clear unavailable handle before import', {
        documentId,
        error,
      })
    }

    const initialValue = options.initialValue!

    const binary = Automerge.save(Automerge.from(initialValue))
    handle = repo.import<RepoDoc>(binary, {
      docId: resolvedDocumentId,
    }) as RepoDocHandle

    if (options.awaitReady === false) {
      tryResolveNonReadyHandle(handle)
    }

    if (options.awaitReady !== false) {
      await awaitHandleReadyIfNeeded(handle)
    }
  }

  return handle
}

function snapshotFromHandle(handle: RepoDocHandle): RepoDoc | null {
  const snapshot = readReadyObjectSnapshot(handle, { resolvePending: true })
  return (snapshot && isPlainObject(snapshot)) ? snapshot : null
}

function readDocumentSnapshot(documentId: string): RepoDoc | null {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId) {
    return null
  }

  return snapshotFromHandle(getRepoHandle(normalizedDocumentId))
}

function getIndexSnapshot(): AutomergeIndexDocument {
  const rawIndex = readDocumentSnapshot(ACCOUNT_INDEX_DOCUMENT_ID)
  return {
    accountId: normalizeItemId(rawIndex?.accountId) || undefined,
    itemIds: normalizeItemIds(rawIndex?.itemIds),
    metadata: normalizeMetadata(rawIndex?.metadata),
  }
}

function getLegacyMetadataSnapshot(): AccountMetadata {
  return normalizeMetadata(readDocumentSnapshot(LEGACY_ACCOUNT_METADATA_DOCUMENT_ID))
}

function isItemDocumentId(documentId: string): boolean {
  return (
    documentId !== ACCOUNT_INDEX_DOCUMENT_ID
    && documentId !== LEGACY_ACCOUNT_METADATA_DOCUMENT_ID
  )
}

function normalizeItemSnapshot(itemId: string, snapshot: RepoDoc | null): Item | null {
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


async function ensureIndexDocument(accountId: string): Promise<void> {
  const initialValue = {
    accountId: normalizeItemId(accountId) || '',
    itemIds: [],
    metadata: {},
  }

  await ensureDocumentHandle(ACCOUNT_INDEX_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue,
    awaitReady: false,
  })

  await withAutomergeDocumentChange(
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      if (typeof doc.accountId !== 'string' || doc.accountId.length === 0) {
        doc.accountId = accountId
      }
    },
    {
      createIfMissing: true,
      initialValue,
    },
  )
}

async function seedImportedDocument(documentId: string, binary: Uint8Array): Promise<void> {
  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(documentId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  try {
    await repo.removeFromCache(resolvedDocumentId)
  } catch {
    // Ignore cache-eviction failures for handles that were never loaded.
  }

  const handle = repo.import<RepoDoc>(binary, {
    docId: resolvedDocumentId,
  }) as RepoDocHandle

  tryResolveNonReadyHandle(handle)

  if (!handle?.isReady() && !handle?.isUnavailable()) {
    await awaitHandleReadyIfNeeded(handle)
  }
}

async function migrateLegacyMetadataSnapshot(accountId: string): Promise<void> {
  const legacyMetadata = getLegacyMetadataSnapshot()
  if (!hasAnyKeys(legacyMetadata as Record<string, unknown>)) {
    return
  }

  await withAutomergeMetadataChange(metadataDraft => {
    if (hasAnyKeys(metadataDraft)) {
      return
    }

    const legacySnapshot = cloneValue(legacyMetadata) as Record<string, unknown>
    for (const key of Object.keys(metadataDraft)) {
      if (!(key in legacySnapshot) || legacySnapshot[key] === undefined) {
        delete metadataDraft[key]
      }
    }
    for (const [key, value] of Object.entries(legacySnapshot)) {
      if (value !== undefined) {
        metadataDraft[key] = value
      }
    }
  }, {
    createIfMissing: true,
    initialValue: {
      accountId: normalizeItemId(accountId) || '',
      itemIds: [],
      metadata: {},
    },
  })
}

export function resolvePendingAutomergeHandles(): void {
  // Doc handle lifecycle is managed by automerge-repo.
}

export async function withAutomergeDocumentChange(
  documentId: string,
  change: (draft: RepoDoc) => void,
  options: ChangeDocumentOptions = {},
): Promise<boolean> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId) {
    return false
  }

  const shouldAddToIndex = options.addToIndex !== false && isItemDocumentId(normalizedDocumentId)

  if (shouldAddToIndex) {
    await addAutomergeItemIdsToIndex([normalizedDocumentId])
  }

  const handle = await ensureDocumentHandle(normalizedDocumentId, {
    createIfMissing: options.createIfMissing,
    initialValue: options.initialValue,
    awaitReady: false,
  } as EnsureHandleOptions)

  if (!handle || handle.isUnavailable() || !handle.isReady()) {
    return false
  }

  handle.change(doc => {
    change(doc as RepoDoc)
  })

  return true
}

export async function withAutomergeMetadataChange(
  change: (metadataDraft: RepoDoc) => void,
  options: ChangeDocumentOptions = {},
): Promise<boolean> {
  return withAutomergeDocumentChange(
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      let metadataDraft = isPlainObject(doc.metadata)
        ? (doc.metadata as RepoDoc)
        : null

      if (!metadataDraft) {
        metadataDraft = {}
        doc.metadata = metadataDraft
      }

      change(metadataDraft)
    },
    {
      createIfMissing: options.createIfMissing ?? true,
      initialValue: options.initialValue || {
        accountId: '',
        itemIds: [],
        metadata: {},
      },
    },
  )
}

export async function addAutomergeItemIdsToIndex(itemIds: string[]): Promise<void> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return
  }

  await withAutomergeDocumentChange(
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      const current = normalizeItemIds((doc as AutomergeIndexDocument).itemIds)
      const next = new Set(current)
      for (const itemId of normalized) {
        next.add(itemId)
      }

      doc.itemIds = Array.from(next)
    },
    {
      createIfMissing: true,
      initialValue: {
        accountId: '',
        itemIds: [],
        metadata: {},
      },
    },
  )
}

export async function removeAutomergeItemIdsFromIndex(itemIds: string[]): Promise<void> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return
  }

  const removeSet = new Set(normalized)

  await withAutomergeDocumentChange(
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      const current = normalizeItemIds((doc as AutomergeIndexDocument).itemIds)
      doc.itemIds = current.filter(itemId => !removeSet.has(itemId))
    },
    {
      createIfMissing: true,
      initialValue: {
        accountId: '',
        itemIds: [],
        metadata: {},
      },
      addToIndex: false,
    },
  )
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  const normalizedAccount = normalizeItemId(account)
  if (!normalizedAccount) {
    return
  }

  await ensureIndexDocument(normalizedAccount)

  if (initializedAccounts.has(normalizedAccount)) {
    return
  }

  await migrateLegacyMetadataSnapshot(normalizedAccount)
  initializedAccounts.add(normalizedAccount)
}

export function listAutomergeItemIds(): string[] {
  return getIndexSnapshot().itemIds || []
}

export function listAutomergeDocumentIds(): string[] {
  const documentIds = new Set<string>([
    ACCOUNT_INDEX_DOCUMENT_ID,
    ...listAutomergeItemIds(),
  ])

  const legacyMetadata = getLegacyMetadataSnapshot()
  if (hasAnyKeys(legacyMetadata as Record<string, unknown>)) {
    documentIds.add(LEGACY_ACCOUNT_METADATA_DOCUMENT_ID)
  }

  return Array.from(documentIds)
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
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return null
  }

  const snapshot = readDocumentSnapshot(normalizedItemId)
  return normalizeItemSnapshot(normalizedItemId, snapshot)
}

export function getAutomergeMetadata(): AccountMetadata {
  const indexMetadata = normalizeMetadata(getIndexSnapshot().metadata)
  if (hasAnyKeys(indexMetadata as Record<string, unknown>)) {
    return indexMetadata
  }

  return getLegacyMetadataSnapshot()
}

export async function hydrateAutomergeDocumentBinary(
  documentId: string,
  binary: Uint8Array,
): Promise<void> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
    return
  }

  await seedImportedDocument(normalizedDocumentId, binary)

  if (isItemDocumentId(normalizedDocumentId)) {
    await addAutomergeItemIdsToIndex([normalizedDocumentId])
    return
  }

  if (normalizedDocumentId === LEGACY_ACCOUNT_METADATA_DOCUMENT_ID) {
    const legacyMetadata = getLegacyMetadataSnapshot()
    if (hasAnyKeys(legacyMetadata as Record<string, unknown>)) {
      await upsertAutomergeMetadataSnapshot(legacyMetadata, {
        markLocalChange: false,
      })
    }
  }
}

export async function upsertAutomergeMetadataSnapshot(
  metadata: AccountMetadata,
  options: UpsertMetadataOptions = {},
): Promise<void> {
  void options.markLocalChange

  const nextMetadata = cloneValue(metadata || {}) as Record<string, unknown>

  await withAutomergeMetadataChange(metadataDraft => {
    for (const key of Object.keys(metadataDraft)) {
      if (!(key in nextMetadata) || nextMetadata[key] === undefined) {
        delete metadataDraft[key]
      }
    }
    for (const [key, value] of Object.entries(nextMetadata)) {
      if (value !== undefined) {
        metadataDraft[key] = value
      }
    }
  })
}

export async function removeAutomergeItem(itemId: string): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return
  }

  await removeAutomergeItemIdsFromIndex([normalizedItemId])

  const repo = getAutomergeRepo()
  const documentUrl = toAutomergeUrlFromItemId(normalizedItemId)

  try {
    repo.delete(documentUrl)
  } catch {
    // Ignore missing local handles.
  }

  try {
    await repo.removeFromCache(interpretAsDocumentId(documentUrl))
  } catch {
    // Ignore cache-eviction failures for handles that were never loaded.
  }
}

export async function clearAutomergeDocStore(): Promise<void> {
  const repo = getAutomergeRepo()
  const documentIds = Array.from(new Set([
    ...listAutomergeDocumentIds(),
    LEGACY_ACCOUNT_METADATA_DOCUMENT_ID,
  ]))

  for (const documentId of documentIds) {
    const documentUrl = toAutomergeUrlFromItemId(documentId)

    try {
      repo.delete(documentUrl)
    } catch {
      // Ignore missing local handles.
    }

    try {
      await repo.removeFromCache(interpretAsDocumentId(documentUrl))
    } catch {
      // Ignore cache-eviction failures for handles that were never loaded.
    }
  }

  initializedAccounts.clear()

  if (typeof indexedDB !== 'undefined') {
    try {
      indexedDB.deleteDatabase('flock-automerge-db')
    } catch {
      // Ignore IndexedDB delete failures in constrained environments.
    }
  }
}

export async function exportAllBinaries(): Promise<Partial<Record<ItemId, string>>> {
  const exported: Partial<Record<ItemId, string>> = {}

  for (const documentId of listAutomergeDocumentIds()) {
    const handle = await ensureDocumentHandle(documentId, {
      awaitReady: false,
    })
    if (!handle || !handle.isReady()) {
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

    await hydrateAutomergeDocumentBinary(documentId, decodeBase64ToBytes(encodedBinary))

    const normalizedDocumentId = normalizeItemId(documentId)
    if (!normalizedDocumentId || !isItemDocumentId(normalizedDocumentId)) {
      continue
    }

    restoredItemIds.push(normalizedDocumentId)
  }

  await addAutomergeItemIdsToIndex(restoredItemIds)

  return restoredItemIds
}
import * as Automerge from '@automerge/automerge/slim'
import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import localforage from 'localforage'
import { z } from 'zod'

import { accountMetadataSchema } from '../shared/schemas/metadata'
import { readItemSchema, errorItemSchema, ErrorItem } from '../shared/schemas/items'
import type { ItemId } from '../shared/itemTypes'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { getAutomergeDBName, getAutomergeRepo, closeAutomergeRepo } from './automergeRepo'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { decodeBase64ToBytes, encodeBytesToBase64 } from './utils/base64Utils'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import { useSyncStore } from '../state/syncStore'
import {
  awaitHandleReadyIfNeeded,
  findRepoDocHandle,
  readReadyObjectSnapshot,
  tryResolveNonReadyHandle,
} from './automergeHandleUtils'

export { ACCOUNT_INDEX_DOCUMENT_ID }

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: string[]
  metadata?: AccountMetadata
  lastModified?: Record<string, number>
}

type RepoDoc = Record<string, unknown>
type RepoDocHandle = DocHandle<RepoDoc> | undefined

type EnsureHandleOptions = {
  awaitReady?: boolean
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

type ChangeDocumentOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
  addToIndex?: boolean
}

const initializedAccounts = new Set<string>()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeItemId(raw: unknown): string | null {
  const result = z.string().trim().min(1).safeParse(raw)
  return result.success ? result.data : null
}

function normalizeItemIds(raw: unknown): string[] {
  const result = z.array(z.string().trim().min(1)).safeParse(raw)
  if (!result.success) return []

  const deduped = new Set<string>()

  for (const normalized of result.data) {
    if (normalized === ACCOUNT_INDEX_DOCUMENT_ID || deduped.has(normalized)) {
      continue
    }

    deduped.add(normalized)
  }

  return Array.from(deduped)
}

function normalizeMetadata(raw: unknown): AccountMetadata {
  const result = accountMetadataSchema.safeParse(raw)
  return result.success ? result.data as AccountMetadata : {}
}

function normalizeLastModified(raw: unknown): Record<string, number> {
  if (!isPlainObject(raw)) {
    return {}
  }

  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value
    }
  }

  return result
}


async function getRepoHandle(accountId: string, itemId: string): Promise<RepoDocHandle> {
  const documentUrl = await toAutomergeUrlFromItemId(itemId)
  return findRepoDocHandle<RepoDoc>(getAutomergeRepo(accountId), documentUrl)
}

async function ensureDocumentHandle(
  accountId: string,
  documentId: string,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = await toAutomergeUrlFromItemId(documentId)
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

    const newDoc = Automerge.from(initialValue)
    const binary = Automerge.save(newDoc)
    try {
      handle = repo.import<RepoDoc>(binary, { docId: resolvedDocumentId })
    } catch (error) {
      console.error('[automerge] failed to import document', {
        documentId,
        error,
      })
    }

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

async function readDocumentSnapshot(accountId: string, documentId: string): Promise<RepoDoc | null> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId) {
    return null
  }

  const handle = await getRepoHandle(accountId, normalizedDocumentId)
  return snapshotFromHandle(handle)
}

async function getIndexSnapshot(accountId: string): Promise<AutomergeIndexDocument> {
  const rawIndex = await readDocumentSnapshot(accountId, ACCOUNT_INDEX_DOCUMENT_ID)
  return {
    accountId: normalizeItemId(rawIndex?.accountId) || undefined,
    itemIds: normalizeItemIds(rawIndex?.itemIds),
    metadata: normalizeMetadata(rawIndex?.metadata),
    lastModified: normalizeLastModified(rawIndex?.lastModified),
  }
}

function isItemDocumentId(documentId: string): boolean {
  return documentId !== ACCOUNT_INDEX_DOCUMENT_ID
}

export function normalizeItemSnapshot(itemId: string, snapshot: RepoDoc | null): Item | null {
  if (!snapshot) {
    return null
  }

  const item = snapshot as Partial<Item>
  const normalizedItem = (typeof item.id === 'string' && item.id.length > 0)
    ? item
    : { ...item, id: itemId }

  const parsed = readItemSchema.safeParse(normalizedItem)
  if (parsed.success) {
    return parsed.data as Item
  }

  const errorParsed = errorItemSchema.safeParse(normalizedItem)
  if (errorParsed.success) {
    return errorParsed.data as unknown as Item
  }

  return {
    id: itemId,
    type: 'error',
    name: 'Corrupt Item',
    description: 'This item could not be parsed.',
    created: typeof normalizedItem.created === 'number' ? normalizedItem.created : Date.now(),
    archived: !!normalizedItem.archived,
    prayerFrequency: 'none',
    notes: [],
    prayedFor: [],
    originalType: normalizedItem.type as ErrorItem['originalType'],
    rawSnapshot: snapshot,
  } as unknown as Item
}


async function ensureIndexDocument(accountId: string): Promise<void> {
  const initialValue = {
    accountId: normalizeItemId(accountId) || '',
    itemIds: [],
    metadata: {},
    lastModified: {},
  }

  await ensureDocumentHandle(accountId, ACCOUNT_INDEX_DOCUMENT_ID, {
    createIfMissing: true,
    initialValue,
    awaitReady: false,
  })

  await withAutomergeDocumentChange(
    accountId,
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

async function seedImportedDocument(accountId: string, documentId: string, binary: Uint8Array): Promise<void> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = await toAutomergeUrlFromItemId(documentId)
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

export async function withAutomergeDocumentChange(
  accountId: string,
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
    await addAutomergeItemIdsToIndex(accountId, [normalizedDocumentId])
  }

  const handle = await ensureDocumentHandle(
    accountId,
    normalizedDocumentId,
    {
      createIfMissing: options.createIfMissing,
      initialValue: options.initialValue,
      awaitReady: false,
    }
  )

  if (!handle || handle.isUnavailable() || !handle.isReady()) {
    return false
  }

  handle.change(change)

  return true
}

export async function withAutomergeMetadataChange(
  accountId: string,
  change: (metadataDraft: RepoDoc) => void,
  options: ChangeDocumentOptions = {},
): Promise<boolean> {
  return withAutomergeDocumentChange(
    accountId,
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
        lastModified: {},
      },
    },
  )
}

export async function addAutomergeItemIdsToIndex(accountId: string, itemIds: string[]): Promise<void> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return
  }

  await withAutomergeDocumentChange(
    accountId,
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      const indexDoc = doc as AutomergeIndexDocument
      if (!indexDoc.itemIds) {
        indexDoc.itemIds = []
      }
      const current = new Set(indexDoc.itemIds)
      for (const itemId of normalized) {
        if (!current.has(itemId)) {
          indexDoc.itemIds.push(itemId)
          current.add(itemId)
        }
      }
    },
    {
      createIfMissing: true,
      initialValue: {
        accountId: '',
        itemIds: [],
        metadata: {},
        lastModified: {},
      },
    },
  )
}

export async function removeAutomergeItemIdsFromIndex(accountId: string, itemIds: string[]): Promise<void> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return
  }

  const removeSet = new Set(normalized)

  await withAutomergeDocumentChange(
    accountId,
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      const indexDoc = doc as AutomergeIndexDocument
      if (!indexDoc.itemIds) {
        indexDoc.itemIds = []
      }
      let lastModified = isPlainObject(indexDoc.lastModified)
        ? (indexDoc.lastModified as Record<string, number>)
        : null
      if (!lastModified) {
        lastModified = {}
        indexDoc.lastModified = lastModified
      }
      for (let i = indexDoc.itemIds.length - 1; i >= 0; i--) {
        const itemId = indexDoc.itemIds[i]
        if (removeSet.has(itemId)) {
          indexDoc.itemIds.splice(i, 1)
        }
      }
      for (const itemId of removeSet) {
        delete lastModified[itemId]
      }
    },
    {
      createIfMissing: true,
      initialValue: {
        accountId: '',
        itemIds: [],
        metadata: {},
        lastModified: {},
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

  initializedAccounts.add(normalizedAccount)
}

export async function listAutomergeItemIds(accountId: string): Promise<string[]> {
  const index = await getIndexSnapshot(accountId)
  return index.itemIds || []
}

async function listAutomergeDocumentIds(accountId: string): Promise<string[]> {
  const documentIds = new Set<string>([
    ACCOUNT_INDEX_DOCUMENT_ID,
    ...(await listAutomergeItemIds(accountId)),
  ])

  return Array.from(documentIds)
}

export async function getAutomergeItem(accountId: string, itemId: string): Promise<Item | null> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return null
  }

  const snapshot = await readDocumentSnapshot(accountId, normalizedItemId)
  return normalizeItemSnapshot(normalizedItemId, snapshot)
}

export async function getAutomergeMetadata(accountId: string): Promise<AccountMetadata> {
  const index = await getIndexSnapshot(accountId)
  return normalizeMetadata(index.metadata)
}

export async function hydrateAutomergeDocumentBinary(
  accountId: string,
  documentId: string,
  binary: Uint8Array,
): Promise<void> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
    return
  }

  try {
    await seedImportedDocument(accountId, normalizedDocumentId, binary)
  } catch (error) {
    console.error('[automerge] failed to hydrate document', {
      documentId,
      error,
    })
    return
  }

  if (isItemDocumentId(normalizedDocumentId)) {
    await addAutomergeItemIdsToIndex(accountId, [normalizedDocumentId])
    return
  }
}

export async function removeAutomergeItem(accountId: string, itemId: string): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return
  }

  await removeAutomergeItemIdsFromIndex(accountId, [normalizedItemId])

  const repo = getAutomergeRepo(accountId)
  const documentUrl = await toAutomergeUrlFromItemId(normalizedItemId)

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

export async function clearAutomergeDocStore(accountId: string): Promise<void> {
  let repo
  try {
    repo = getAutomergeRepo(accountId)
  } catch {
    // Ignore if not initialized
  }

  if (repo) {
    const documentIds = Array.from(new Set([
      ...(await listAutomergeDocumentIds(accountId)),
    ]))

    for (const documentId of documentIds) {
      const documentUrl = await toAutomergeUrlFromItemId(documentId)

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
  }

  initializedAccounts.clear()

  try {
    await closeAutomergeRepo(accountId)
  } catch (err) {
    console.error('[automergeDocStore] Failed to close repo before database deletion:', err)
  }

  try {
    const dbName = getAutomergeDBName(accountId)
    await localforage.dropInstance({ name: dbName })
  } catch (error) {
    console.error('[automergeDocStore] failed to delete indexedDB database:', error)
  }
}

export async function exportAllBinaries(accountId: string): Promise<Partial<Record<ItemId, string>>> {
  const exported: Partial<Record<ItemId, string>> = {}

  for (const documentId of await listAutomergeDocumentIds(accountId)) {
    const handle = await ensureDocumentHandle(accountId, documentId, {
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

export async function restoreFromBinaries(accountId: string, documents: Partial<Record<ItemId, string>>): Promise<string[]> {
  const restoredItemIds: string[] = []

  for (const [documentId, encodedBinary] of Object.entries(documents)) {
    if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) {
      continue
    }

    await hydrateAutomergeDocumentBinary(accountId, documentId, decodeBase64ToBytes(encodedBinary))

    const normalizedDocumentId = normalizeItemId(documentId)
    if (!normalizedDocumentId || !isItemDocumentId(normalizedDocumentId)) {
      continue
    }

    restoredItemIds.push(normalizedDocumentId)
  }

  await addAutomergeItemIdsToIndex(accountId, restoredItemIds)

  useSyncStore.getState().incrementGeneration()

  return restoredItemIds
}
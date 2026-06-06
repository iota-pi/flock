import { z } from 'zod'
import localforage from 'localforage'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'

import { accountMetadataSchema } from '../../shared/schemas/metadata'
import type { AccountMetadata } from '../../state/metadata'
import { getAutomergeDBName, getAutomergeRepo, closeAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import { isPlainObject } from '../utils'
import { normalizeItemId, readDocumentSnapshot, changeDocument } from './core'

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: string[]
  metadata?: AccountMetadata
  lastModified?: Record<string, number>
}

export const initializedAccounts = new Set<string>()

export function normalizeItemIds(raw: unknown): string[] {
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

export function normalizeMetadata(raw: unknown): AccountMetadata {
  const result = accountMetadataSchema.safeParse(raw)
  return result.success ? result.data as AccountMetadata : {}
}

export function normalizeLastModified(raw: unknown): Record<string, number> {
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

export async function getIndexSnapshot(accountId: string): Promise<AutomergeIndexDocument> {
  const rawIndex = await readDocumentSnapshot(accountId, ACCOUNT_INDEX_DOCUMENT_ID)
  return {
    accountId: normalizeItemId(rawIndex?.accountId) || undefined,
    itemIds: normalizeItemIds(rawIndex?.itemIds),
    metadata: normalizeMetadata(rawIndex?.metadata),
    lastModified: normalizeLastModified(rawIndex?.lastModified),
  }
}

export async function ensureIndexDocument(accountId: string): Promise<void> {
  const initialValue = {
    accountId: normalizeItemId(accountId) || '',
    itemIds: [],
    metadata: {},
    lastModified: {},
  }

  await changeDocument(
    accountId,
    ACCOUNT_INDEX_DOCUMENT_ID,
    doc => {
      if (doc && (typeof doc.accountId !== 'string' || doc.accountId.length === 0)) {
        doc.accountId = accountId
      }
    },
    {
      createIfMissing: true,
      initialValue,
    },
  )
}

export async function addAutomergeItemIdsToIndex(accountId: string, itemIds: string[]): Promise<void> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return
  }

  await changeDocument(
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

  await changeDocument(
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
    },
  )
}

export async function listAutomergeItemIds(accountId: string): Promise<string[]> {
  const index = await getIndexSnapshot(accountId)
  return index.itemIds || []
}

export async function getAutomergeMetadata(accountId: string): Promise<AccountMetadata> {
  const index = await getIndexSnapshot(accountId)
  return normalizeMetadata(index.metadata)
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  const normalizedAccount = normalizeItemId(account)
  if (!normalizedAccount) {
    return
  }

  if (initializedAccounts.has(normalizedAccount)) {
    return
  }

  await ensureIndexDocument(normalizedAccount)
  initializedAccounts.add(normalizedAccount)
}

export async function listAutomergeDocumentIds(accountId: string): Promise<string[]> {
  const documentIds = new Set<string>([
    ACCOUNT_INDEX_DOCUMENT_ID,
    ...(await listAutomergeItemIds(accountId)),
  ])

  return Array.from(documentIds)
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

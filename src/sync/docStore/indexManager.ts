import { z } from 'zod'

import { accountMetadataSchema } from '../../shared/schemas/metadata'
import type { AccountMetadata } from '../../state/metadata'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import { isPlainObject } from '../utils'
import { normalizeItemId, readDocumentSnapshot } from './core'

export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: string[]
  metadata?: AccountMetadata
  lastModified?: Record<string, number>
}

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
  const { withAutomergeDocumentChange } = await import('./items')
  const initialValue = {
    accountId: normalizeItemId(accountId) || '',
    itemIds: [],
    metadata: {},
    lastModified: {},
  }

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

export async function addAutomergeItemIdsToIndex(accountId: string, itemIds: string[]): Promise<void> {
  const { withAutomergeDocumentChange } = await import('./items')
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
  const { withAutomergeDocumentChange } = await import('./items')
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

export async function listAutomergeItemIds(accountId: string): Promise<string[]> {
  const index = await getIndexSnapshot(accountId)
  return index.itemIds || []
}

export async function getAutomergeMetadata(accountId: string): Promise<AccountMetadata> {
  const index = await getIndexSnapshot(accountId)
  return normalizeMetadata(index.metadata)
}

import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import { readItemSchema, errorItemSchema, ErrorItem, ItemId } from '../../shared/schemas/items'
import type { Item } from '../../state/items'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { isPlainObject } from '../utils'
import {
  normalizeItemId,
  readItemSnapshot,
  changeDocument,
  RepoDoc,
  ChangeDocumentOptions,
} from './core'
import {
  addAutomergeItemIdsToIndex,
  removeAutomergeItemIdsFromIndex,
} from './indexManager'

export type ChangeItemOptions = ChangeDocumentOptions & {
  addToIndex?: boolean
}

function isNonIndexItem(id: ItemId): boolean {
  return id !== ACCOUNT_INDEX_DOCUMENT_ID
}

export function normalizeItemSnapshot(itemId: ItemId, snapshot: RepoDoc | null): Item | null {
  if (!snapshot || Object.keys(snapshot).length === 0) {
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
    return errorParsed.data as Item
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
  } as Item
}

export async function withAutomergeDocumentChange(
  accountId: string,
  itemId: ItemId,
  change: (draft: RepoDoc) => void,
  options: ChangeItemOptions = {},
): Promise<boolean> {
  const normalizedDocumentId = normalizeItemId(itemId)
  if (!normalizedDocumentId) {
    return false
  }

  const shouldAddToIndex = options.addToIndex !== false && isNonIndexItem(normalizedDocumentId)

  if (shouldAddToIndex) {
    await addAutomergeItemIdsToIndex(accountId, [normalizedDocumentId])
  }

  return changeDocument(
    accountId,
    normalizedDocumentId,
    change,
    {
      createIfMissing: options.createIfMissing,
      initialValue: options.initialValue,
    }
  )
}

export async function withAutomergeMetadataChange(
  accountId: string,
  change: (metadataDraft: RepoDoc) => void,
  options: ChangeItemOptions = {},
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

export async function getAutomergeItem(accountId: string, itemId: ItemId): Promise<Item | null> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return null
  }

  const snapshot = await readItemSnapshot(accountId, normalizedItemId)
  return normalizeItemSnapshot(normalizedItemId, snapshot)
}

export async function removeAutomergeItem(accountId: string, itemId: ItemId): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return
  }

  await removeAutomergeItemIdsFromIndex(accountId, [normalizedItemId])

  const repo = getAutomergeRepo(accountId)
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

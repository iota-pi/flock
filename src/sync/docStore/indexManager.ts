import { z } from 'zod'
import localforage from 'localforage'
import type { AccountMetadata } from '../../state/metadata'
import { getAutomergeDBName, closeAutomergeRepo, getAutomergeRepo } from '../automergeRepo'
import { ItemId, ItemIdSchema } from 'src/shared/schemas/items'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'


export type AutomergeIndexDocument = {
  accountId?: string
  itemIds?: ItemId[]
  metadata?: AccountMetadata
  lastModified?: Record<ItemId, number>
}

export const initializedAccounts = new Set<string>()

function getIndexStore(accountId: string) {
  return localforage.createInstance({
    name: 'flock-item-metadata',
    storeName: `index-${accountId}`,
  })
}

export function normalizeItemIds(raw: unknown): ItemId[] {
  const result = z.array(ItemIdSchema).safeParse(raw)
  if (!result.success) return []

  const deduped = new Set<ItemId>(result.data)
  return Array.from(deduped)
}

export async function getIndexSnapshot(accountId: string): Promise<AutomergeIndexDocument> {
  const store = getIndexStore(accountId)
  const doc = await store.getItem<AutomergeIndexDocument>('indexDoc')
  return {
    accountId: doc?.accountId || accountId,
    itemIds: doc?.itemIds || [],
    metadata: doc?.metadata || {},
    lastModified: doc?.lastModified || {},
  }
}

export async function ensureIndexDocument(accountId: string): Promise<void> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  if (!doc.accountId) {
    doc.accountId = accountId
    await store.setItem('indexDoc', doc)
  }
}

export async function addAutomergeItemIdsToIndex(accountId: string, itemIds: ItemId[]): Promise<void> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  const current = new Set(doc.itemIds)
  let updated = false
  for (const itemId of itemIds) {
    if (!current.has(itemId)) {
      doc.itemIds!.push(itemId)
      current.add(itemId)
      updated = true
    }
  }
  if (updated) {
    await store.setItem('indexDoc', doc)
  }
}

export async function removeAutomergeItemIdsFromIndex(accountId: string, itemIds: ItemId[]): Promise<void> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  const removeSet = new Set(itemIds)
  const newItemIds = doc.itemIds?.filter(id => !removeSet.has(id)) || []
  const lastModified = doc.lastModified || {}

  for (const id of removeSet) {
    delete lastModified[id]
  }

  doc.itemIds = newItemIds
  doc.lastModified = lastModified
  await store.setItem('indexDoc', doc)
}

export async function listAutomergeItemIds(accountId: string): Promise<ItemId[]> {
  const index = await getIndexSnapshot(accountId)
  return index.itemIds || []
}

export async function getAutomergeMetadata(accountId: string): Promise<AccountMetadata> {
  const index = await getIndexSnapshot(accountId)
  return index.metadata || {}
}

export async function updateLocalMetadata(accountId: string, metadata: AccountMetadata): Promise<void> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  doc.metadata = metadata
  await store.setItem('indexDoc', doc)
}

export async function updateAutomergeMetadata(accountId: string, changes: Partial<AccountMetadata>): Promise<AccountMetadata> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  doc.metadata = { ...doc.metadata, ...changes }
  await store.setItem('indexDoc', doc)
  return doc.metadata || {}
}

export async function restoreIndexSnapshot(accountId: string, snapshot: AutomergeIndexDocument): Promise<void> {
  const store = getIndexStore(accountId)
  await store.setItem('indexDoc', snapshot)
}

export async function updateLocalLastModified(accountId: string, lastModified: Record<ItemId, number>): Promise<void> {
  const store = getIndexStore(accountId)
  const doc = await getIndexSnapshot(accountId)
  doc.lastModified = { ...doc.lastModified, ...lastModified }
  await store.setItem('indexDoc', doc)
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  if (initializedAccounts.has(account)) {
    return
  }
  await ensureIndexDocument(account)
  initializedAccounts.add(account)
}

export async function listAllAutomergeItemIds(accountId: string): Promise<ItemId[]> {
  return await listAutomergeItemIds(accountId)
}

export async function clearAutomergeDocStore(accountId: string): Promise<void> {
  let repo
  try {
    repo = getAutomergeRepo(accountId)
  } catch {
    // Ignore if not initialized
  }

  if (repo) {
    const itemIds = await listAllAutomergeItemIds(accountId)

    for (const itemId of itemIds) {
      const documentUrl = toAutomergeUrlFromItemId(itemId)
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
    const store = getIndexStore(accountId)
    await store.clear()
  } catch (error) {
    console.error('[automergeDocStore] failed to clear indexStore:', error)
  }

  try {
    const dbName = getAutomergeDBName(accountId)
    await localforage.dropInstance({ name: dbName })
  } catch (error) {
    console.error('[automergeDocStore] failed to delete indexedDB database:', error)
  }
}

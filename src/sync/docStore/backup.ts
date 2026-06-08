import * as Automerge from '@automerge/automerge/slim'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'

import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { useSyncStore } from '../../state/syncStore'
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../utils'
import {
  ensureDocumentHandle,
  normalizeItemId,
  RepoDoc,
} from './core'
import {
  addAutomergeItemIdsToIndex,
  getIndexSnapshot,
  listAllAutomergeItemIds,
  restoreIndexSnapshot,
} from './indexManager'
import { ItemId } from 'src/shared/schemas/items'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'


export async function seedImportedDocument(accountId: string, itemId: ItemId, binary: Uint8Array): Promise<void> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  try {
    await repo.removeFromCache(resolvedDocumentId)
  } catch {
    // Ignore cache-eviction failures for handles that were never loaded.
  }

  repo.import<RepoDoc>(binary, {
    docId: resolvedDocumentId,
  })
}

export async function hydrateAutomergeDocumentBinary(
  accountId: string,
  itemId: string,
  binary: Uint8Array,
): Promise<void> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId || !(binary instanceof Uint8Array) || binary.byteLength === 0) {
    return
  }

  try {
    await seedImportedDocument(accountId, normalizedItemId, binary)
  } catch (error) {
    console.error('[automerge] failed to hydrate document', {
      itemId,
      error,
    })
    return
  }

  await addAutomergeItemIdsToIndex(accountId, [normalizedItemId])
}

export async function exportAllBinaries(accountId: string): Promise<Partial<Record<ItemId, string>>> {
  const exported: Partial<Record<ItemId, string>> = {}

  // 1. Export Automerge items
  for (const itemId of await listAllAutomergeItemIds(accountId)) {
    const handle = await ensureDocumentHandle(accountId, itemId)
    if (!handle || !handle.isReady()) {
      continue
    }

    const doc = handle.doc()
    if (!doc) {
      continue
    }

    const binary = Automerge.save(doc)
    exported[itemId] = encodeBytesToBase64(binary)
  }

  // 2. Export native index metadata
  const indexDoc = await getIndexSnapshot(accountId)
  const indexBinary = new TextEncoder().encode(JSON.stringify(indexDoc))
  const indexId = ACCOUNT_INDEX_DOCUMENT_ID as unknown as ItemId
  exported[indexId] = encodeBytesToBase64(indexBinary)

  return exported
}

export async function restoreFromBinaries(accountId: string, items: Partial<Record<ItemId, string>>): Promise<ItemId[]> {
  const restoredItemIds: ItemId[] = []

  // 1. Intercept and restore the native index/metadata first if present
  const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID as unknown as ItemId]
  if (encodedIndex && typeof encodedIndex === 'string') {
    try {
      const indexBinary = decodeBase64ToBytes(encodedIndex)
      const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
      if (indexDoc && typeof indexDoc === 'object') {
        await restoreIndexSnapshot(accountId, indexDoc)
      }
    } catch (err) {
      console.error('[backup] Failed to restore native index metadata from backup', err)
    }
  }

  // 2. Restore individual Automerge item documents
  for (const [itemId, encodedBinary] of Object.entries(items)) {
    if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) {
      continue
    }

    if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) {
      continue
    }

    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId) {
      continue
    }
    await hydrateAutomergeDocumentBinary(
      accountId,
      normalizedItemId,
      decodeBase64ToBytes(encodedBinary),
    )

    restoredItemIds.push(normalizedItemId)
  }

  await addAutomergeItemIdsToIndex(accountId, restoredItemIds)

  useSyncStore.getState().incrementGeneration()

  return restoredItemIds
}

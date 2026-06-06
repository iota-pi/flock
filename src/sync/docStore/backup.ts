import * as Automerge from '@automerge/automerge/slim'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'

import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { useSyncStore } from '../../state/syncStore'
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../utils'
import {
  tryResolveNonReadyHandle,
  awaitHandleReadyIfNeeded,
} from '../automergeHandleUtils'
import {
  ensureDocumentHandle,
  normalizeItemId,
  RepoDocHandle,
  RepoDoc,
} from './core'
import {
  addAutomergeItemIdsToIndex,
  listAllAutomergeItemIds,
} from './indexManager'
import { ItemId } from 'src/shared/schemas/items'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../docStore'


export async function seedImportedDocument(accountId: string, itemId: ItemId, binary: Uint8Array): Promise<void> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = toAutomergeUrlFromItemId(itemId)
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
  await awaitHandleReadyIfNeeded(handle)
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

  if (itemId !== ACCOUNT_INDEX_DOCUMENT_ID) {
    await addAutomergeItemIdsToIndex(accountId, [normalizedItemId])
    return
  }
}

export async function exportAllBinaries(accountId: string): Promise<Partial<Record<ItemId, string>>> {
  const exported: Partial<Record<ItemId, string>> = {}

  for (const itemId of await listAllAutomergeItemIds(accountId)) {
    const handle = await ensureDocumentHandle(accountId, itemId, {
      awaitReady: false,
    })
    if (!handle || !handle.isReady()) {
      continue
    }

    const binary = Automerge.save(handle.doc())
    exported[itemId] = encodeBytesToBase64(binary)
  }

  return exported
}

export async function restoreFromBinaries(accountId: string, items: Partial<Record<ItemId, string>>): Promise<ItemId[]> {
  const restoredItemIds: ItemId[] = []

  for (const [itemId, encodedBinary] of Object.entries(items)) {
    if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) {
      continue
    }

    await hydrateAutomergeDocumentBinary(accountId, itemId, decodeBase64ToBytes(encodedBinary))

    const normalizedItemId = normalizeItemId(itemId)
    if (!normalizedItemId || normalizedItemId === ACCOUNT_INDEX_DOCUMENT_ID) {
      continue
    }

    restoredItemIds.push(normalizedItemId)
  }

  await addAutomergeItemIdsToIndex(accountId, restoredItemIds)

  useSyncStore.getState().incrementGeneration()

  return restoredItemIds
}

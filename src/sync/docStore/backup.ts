import * as Automerge from '@automerge/automerge/slim'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'

import type { ItemId } from '../../shared/itemTypes'
import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { useSyncStore } from '../../state/syncStore'
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../utils'
import {
  ensureDocumentHandle,
  normalizeItemId,
  resolveHandleReadyState,
  RepoDocHandle,
  RepoDoc,
} from './core'

export async function seedImportedDocument(accountId: string, documentId: string, binary: Uint8Array): Promise<void> {
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

  const { tryResolveNonReadyHandle } = await import('../automergeHandleUtils')
  tryResolveNonReadyHandle(handle)

  if (!handle?.isReady() && !handle?.isUnavailable()) {
    const { awaitHandleReadyIfNeeded } = await import('../automergeHandleUtils')
    await awaitHandleReadyIfNeeded(handle)
  }
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

  if (documentId !== 'account-index') {
    const { addAutomergeItemIdsToIndex } = await import('./indexManager')
    await addAutomergeItemIdsToIndex(accountId, [normalizedDocumentId])
    return
  }
}

export async function exportAllBinaries(accountId: string): Promise<Partial<Record<ItemId, string>>> {
  const { listAutomergeDocumentIds } = await import('./core')
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
    if (!normalizedDocumentId || normalizedDocumentId === 'account-index') {
      continue
    }

    restoredItemIds.push(normalizedDocumentId)
  }

  const { addAutomergeItemIdsToIndex } = await import('./indexManager')
  await addAutomergeItemIdsToIndex(accountId, restoredItemIds)

  useSyncStore.getState().incrementGeneration()

  return restoredItemIds
}

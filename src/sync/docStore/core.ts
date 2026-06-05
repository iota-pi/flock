import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import localforage from 'localforage'
import { z } from 'zod'

import { getAutomergeDBName, getAutomergeRepo, closeAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import {
  awaitHandleReadyIfNeeded,
  findRepoDocHandle,
  readReadyObjectSnapshot,
  tryResolveNonReadyHandle,
} from '../automergeHandleUtils'
import { isPlainObject } from '../utils'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined

export type EnsureHandleOptions = {
  awaitReady?: boolean
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

export const initializedAccounts = new Set<string>()

export function normalizeItemId(raw: unknown): string | null {
  const result = z.string().trim().min(1).safeParse(raw)
  return result.success ? result.data : null
}

export async function getRepoHandle(accountId: string, itemId: string): Promise<RepoDocHandle> {
  const documentUrl = await toAutomergeUrlFromItemId(itemId)
  return findRepoDocHandle<RepoDoc>(getAutomergeRepo(accountId), documentUrl)
}

export async function resolveHandleReadyState<TDoc extends object>(
  handle: DocHandle<TDoc> | undefined,
  awaitReady?: boolean,
): Promise<void> {
  if (awaitReady === false) {
    tryResolveNonReadyHandle(handle)
  } else {
    await awaitHandleReadyIfNeeded(handle)
  }
}

export async function ensureDocumentHandle(
  accountId: string,
  documentId: string,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = await toAutomergeUrlFromItemId(documentId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  let handle = findRepoDocHandle<RepoDoc>(repo, documentUrl)

  await resolveHandleReadyState(handle, options.awaitReady)

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

    await resolveHandleReadyState(handle, options.awaitReady)
  }

  return handle
}

export function snapshotFromHandle(handle: RepoDocHandle): RepoDoc | null {
  const snapshot = readReadyObjectSnapshot(handle, { resolvePending: true })
  return (snapshot && isPlainObject(snapshot)) ? snapshot : null
}

export async function readDocumentSnapshot(accountId: string, documentId: string): Promise<RepoDoc | null> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId) {
    return null
  }

  const handle = await getRepoHandle(accountId, normalizedDocumentId)
  return snapshotFromHandle(handle)
}

export async function initializeAutomergeDocStore(account: string): Promise<void> {
  const normalizedAccount = normalizeItemId(account)
  if (!normalizedAccount) {
    return
  }

  if (initializedAccounts.has(normalizedAccount)) {
    return
  }

  // Ensure index document will be imported/called from indexManager to avoid circular dependencies
  const { ensureIndexDocument } = await import('./indexManager')
  await ensureIndexDocument(normalizedAccount)
  initializedAccounts.add(normalizedAccount)
}

export async function listAutomergeDocumentIds(accountId: string): Promise<string[]> {
  const { listAutomergeItemIds } = await import('./indexManager')
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

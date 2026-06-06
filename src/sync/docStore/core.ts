import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'
import { z } from 'zod'

import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
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

export type ChangeDocumentOptions = {
  createIfMissing?: boolean
  initialValue?: RepoDoc
}

export function normalizeItemId(raw: unknown): string | null {
  const result = z.string().trim().min(1).safeParse(raw)
  return result.success ? result.data : null
}

export async function getRepoHandle(accountId: string, itemId: string): Promise<RepoDocHandle> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
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
  const documentUrl = toAutomergeUrlFromItemId(documentId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  let handle = findRepoDocHandle<RepoDoc>(repo, documentUrl)

  await resolveHandleReadyState(handle, options.awaitReady)

  if ((!handle || handle.isUnavailable()) && options.createIfMissing) {
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

export async function changeDocument(
  accountId: string,
  documentId: string,
  change: (draft: RepoDoc) => void,
  options: ChangeDocumentOptions = {},
): Promise<boolean> {
  const normalizedDocumentId = normalizeItemId(documentId)
  if (!normalizedDocumentId) {
    return false
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

import { interpretAsDocumentId, type DocHandle } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'

import { getAutomergeRepo } from '../automergeRepo'
import { toAutomergeUrlFromItemId } from '../automergeRepoIds'
import {
  awaitHandleReadyIfNeeded,
  findRepoDocHandle,
  readReadyObjectSnapshot,
  tryResolveNonReadyHandle,
} from '../automergeHandleUtils'
import { isPlainObject } from '../utils'
import { ItemId, ItemIdSchema } from 'src/shared/schemas/items'


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

export function normalizeItemId(raw: unknown): ItemId | null {
  const result = ItemIdSchema.safeParse(raw)
  return result.success ? result.data : null
}

export async function getRepoHandle(accountId: string, itemId: ItemId): Promise<RepoDocHandle> {
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
  itemId: ItemId,
  options: EnsureHandleOptions = {},
): Promise<RepoDocHandle> {
  const repo = getAutomergeRepo(accountId)
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const resolvedDocumentId = interpretAsDocumentId(documentUrl)

  let handle = findRepoDocHandle<RepoDoc>(repo, documentUrl)

  await resolveHandleReadyState(handle, options.awaitReady)

  if ((!handle || handle.isUnavailable()) && options.createIfMissing) {
    try {
      repo.delete(resolvedDocumentId)
    } catch (error) {
      console.error('[automerge] failed to clear unavailable handle before import', {
        itemId,
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
        itemId,
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

export async function readItemSnapshot(accountId: string, itemId: ItemId): Promise<RepoDoc | null> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return null
  }

  const handle = await getRepoHandle(accountId, normalizedItemId)
  return snapshotFromHandle(handle)
}

export async function changeDocument(
  accountId: string,
  itemId: ItemId,
  change: (draft: RepoDoc) => void,
  options: ChangeDocumentOptions = {},
): Promise<boolean> {
  const normalizedItemId = normalizeItemId(itemId)
  if (!normalizedItemId) {
    return false
  }

  const handle = await ensureDocumentHandle(
    accountId,
    normalizedItemId,
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

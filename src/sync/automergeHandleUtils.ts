import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo/slim'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import { isPlainObject } from './utils/objectUtils'


type HandleWithDoneLoading<TDoc extends object> = DocHandle<TDoc> & {
  doneLoading?: () => void
}

export function findRepoDocHandle<TDoc extends object>(
  repo: Repo,
  documentUrl: AutomergeUrl,
): DocHandle<TDoc> | undefined {
  try {
    const documentId = interpretAsDocumentId(documentUrl)
    if (!repo.handles[documentId]) {
      repo.find<TDoc>(documentUrl).catch(() => {
        // Swallowed: we only want to trigger the background load and cache population
      })
    }
    return repo.handles[documentId] as DocHandle<TDoc> | undefined
  } catch {
    return undefined
  }
}

export function tryResolveNonReadyHandle<TDoc extends object>(handle: DocHandle<TDoc> | undefined): void {
  if (!handle || handle.isReady() || handle.isUnavailable()) {
    return
  }

  try {
    (handle as HandleWithDoneLoading<TDoc>).doneLoading?.()
  } catch {
    // Keep current handle state if doneLoading is unsupported.
  }
}

export async function awaitHandleReadyIfNeeded<TDoc extends object>(
  handle: DocHandle<TDoc> | undefined,
): Promise<void> {
  if (!handle || handle.isReady() || handle.isUnavailable()) {
    return
  }

  await handle.whenReady(['ready', 'unavailable'])
}

function readHandleDocSafely<TDoc extends object>(handle: DocHandle<TDoc> | undefined): TDoc | undefined {
  if (!handle) {
    return undefined
  }

  try {
    return handle.doc()
  } catch {
    return undefined
  }
}

export function readReadyObjectSnapshot<TDoc extends object>(
  handle: DocHandle<TDoc> | undefined,
  options: { resolvePending?: boolean } = {},
): TDoc | null {
  if (!handle || handle.isUnavailable()) {
    return null
  }

  if (!handle.isReady() && options.resolvePending) {
    tryResolveNonReadyHandle(handle)
  }

  if (!handle.isReady() || handle.isUnavailable()) {
    return null
  }

  const doc = readHandleDocSafely(handle)
  return isPlainObject(doc) ? (doc as TDoc) : null
}


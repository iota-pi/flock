import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim'
import { isPlainObject } from './utils/objectUtils'


type RepoWithProgress = {
  findWithProgress: <TDoc extends object>(documentUrl: AutomergeUrl) => {
    handle: DocHandle<TDoc> | undefined
  }
}

type HandleWithDoneLoading<TDoc extends object> = DocHandle<TDoc> & {
  doneLoading?: () => void
}

export function findRepoDocHandle<TDoc extends object>(
  repo: RepoWithProgress,
  documentUrl: AutomergeUrl,
): DocHandle<TDoc> | undefined {
  try {
    return repo.findWithProgress<TDoc>(documentUrl).handle as DocHandle<TDoc> | undefined
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


import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo/slim'
import { withTimeout } from '../../utils/abort'

export type DocLookupResult<T> =
  | { type: 'found'; handle: DocHandle<T> | undefined }
  | { type: 'timeout' }

/**
 * Looks the document up, giving up after `timeoutMs`. `repo.find` can stay pending forever: for a
 * document whose local records fail to decrypt, and for one missing from storage, which no peer
 * answers for. A lookup that fails for any other reason finds no handle. An abort of the caller's
 * `signal` is rethrown, so the caller stops rather than counting it as this document's failure.
 */
export async function findWithTimeout<T>(
  repo: Repo,
  url: AutomergeUrl,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DocLookupResult<T>> {
  signal?.throwIfAborted()
  return withTimeout(timeoutMs, async lookupSignal => {
    try {
      return { type: 'found', handle: await repo.find<T>(url, { signal: lookupSignal }) }
    } catch {
      signal?.throwIfAborted()
      return lookupSignal.aborted ? { type: 'timeout' } : { type: 'found', handle: undefined }
    }
  }, { signal })
}

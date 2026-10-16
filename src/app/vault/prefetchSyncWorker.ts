// Vite turns this import into the built worker's URL; the rule checks the worker source's exports
// eslint-disable-next-line import-x/default
import vaultWorkerUrl from './vault.worker.ts?worker&url'
import automergeWasmUrl from '@automerge/automerge/automerge.wasm?url'

let prefetched = false

/**
 * Warms the HTTP cache with the sync worker and the Automerge wasm while the user is still logged out.
 * Otherwise they only download once login finishes, and one after the other: the worker has to load
 * before it requests the wasm. Prefetch runs at idle priority, so it doesn't slow down page chunks.
 */
export function prefetchSyncWorker() {
  if (prefetched) {
    return
  }
  prefetched = true

  for (const href of [vaultWorkerUrl, automergeWasmUrl]) {
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.href = href
    document.head.appendChild(link)
  }
}

// Vite turns this import into the built worker's URL; the rule checks the worker source's exports
// eslint-disable-next-line import-x/default
import vaultWorkerUrl from './vault.worker.ts?worker&url'
import automergeWasmUrl from '@automerge/automerge/automerge.wasm?url'

let prefetched = false

/**
 * Warms the HTTP cache with the sync worker and the Automerge wasm while the user is still logged out.
 * Otherwise they only download once login finishes, and one after the other: the worker has to load
 * before it requests the wasm. The fetches run at low priority, so they don't slow down page chunks.
 *
 * This uses fetch rather than `<link rel="prefetch">`, which the CSP checks against `default-src`;
 * fetch falls under `connect-src 'self'`. A failure only loses the warm-up, so it's ignored.
 */
export function prefetchSyncWorker() {
  if (prefetched) {
    return
  }
  prefetched = true

  for (const href of [vaultWorkerUrl, automergeWasmUrl]) {
    fetch(href, { priority: 'low' })
      .then(response => response.arrayBuffer())
      .catch(() => {})
  }
}

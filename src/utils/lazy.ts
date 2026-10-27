// eslint-disable-next-line no-restricted-imports -- this is the wrapper the rule points to
import { lazy as reactLazy } from 'react'

const pendingLoads = new Set<Promise<unknown>>()

/**
 * `React.lazy` that records its in-flight load so tests can wait for it (see `settleLazyLoads`).
 */
export const lazy: typeof reactLazy = load => reactLazy(() => {
  const promise = load()
  pendingLoads.add(promise)
  const settle = () => { pendingLoads.delete(promise) }
  promise.then(settle, settle)
  return promise
})

/**
 * Resolves once every lazy load that has started has settled.
 *
 * Test files share module state, so a lazy component is shared by every file in a worker. If its
 * import is still running when the file that started it finishes, the worker can reject it, and
 * `React.lazy` then rethrows that rejection in every later file. Tests await this before each file
 * finishes so loads complete in the file that started them.
 */
export async function settleLazyLoads() {
  while (pendingLoads.size > 0) {
    await Promise.allSettled(pendingLoads)
  }
}

import { isPageInPlaceOfFile } from 'src/utils/builtAssets'
import { createLogger } from 'src/utils/logger'
import { forceAppUpdate } from './appUpdate'
import { handleClientOutdated } from './vault/clientOutdated'

const log = createLogger('brokenBuild')

/** Whether an error says a lazily loaded script couldn't be loaded */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return (
    message.includes('dynamically imported module') ||
    message.includes('Failed to load module script') ||
    message.includes('Loading chunk')
  )
}

/**
 * Deletes cached copies of files that are really the app shell, which the service worker would
 * otherwise keep serving. Returns how many it deleted.
 */
export async function purgePagesCachedAsFiles(): Promise<number> {
  if (typeof caches === 'undefined') return 0
  let purged = 0
  for (const name of await caches.keys()) {
    const cache = await caches.open(name)
    for (const request of await cache.keys()) {
      const response = await cache.match(request)
      if (response && isPageInPlaceOfFile(request.url, response)) {
        await cache.delete(request)
        purged += 1
      }
    }
  }
  return purged
}

/**
 * Recovers from a script that failed to load, which means this build's files are gone from both
 * the server and the service worker's cache (or cached broken). Reloading alone can bring back
 * the same build, so this clears out broken copies, then takes the newest version: the service
 * worker's update if there is one, or a reload, which now fetches the missing files from the server.
 */
export async function recoverFromChunkLoadError(showWarning: (message: string) => void): Promise<void> {
  try {
    const purged = await purgePagesCachedAsFiles()
    if (purged > 0) {
      log.warn(`Removed ${purged} cached files that were really the app shell`)
    }
  } catch (error) {
    log.warn('Could not check the cache for broken files', error)
  }
  await handleClientOutdated({ showWarning, applyUpdate: forceAppUpdate })
}

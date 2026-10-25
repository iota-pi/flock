import { SYNC_TIMEOUTS } from '../syncConfig'
import { createLogger } from './logger'

const log = createLogger('deleteDatabase')

/**
 * Deletes an IndexedDB database by name, such as an account's plaintext or sealed Automerge database.
 * Close every connection to it first: an open one blocks the deletion until it times out.
 */
export async function deleteDatabase(dbName: string, timeoutMs: number = SYNC_TIMEOUTS.localDataCleanup): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let isBlocked = false

    const req = indexedDB.deleteDatabase(dbName)
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      req.onsuccess = null
      req.onerror = null
      req.onblocked = null
    }

    timer = setTimeout(() => {
      if (settled) return
      const errMsg = isBlocked
        ? `deleteDatabase blocked and timed out after ${timeoutMs}ms for ${dbName}`
        : `deleteDatabase timed out after ${timeoutMs}ms for ${dbName}`
      log.error(errMsg)
      cleanup()
      reject(new Error(errMsg))
    }, timeoutMs)

    req.onsuccess = () => {
      if (settled) return
      cleanup()
      resolve()
    }

    req.onerror = () => {
      if (settled) return
      log.error(`Error deleting IndexedDB database ${dbName}:`, req.error)
      const err = req.error || new Error(`Error deleting IndexedDB database ${dbName}`)
      cleanup()
      reject(err)
    }

    req.onblocked = () => {
      if (settled) return
      isBlocked = true
      log.warn(`deleteDatabase blocked for ${dbName}, waiting for open connections to close`)
    }
  })
}

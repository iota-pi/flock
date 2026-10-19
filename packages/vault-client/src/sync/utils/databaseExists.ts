const DATABASES_TIMEOUT_MS = 1500
const PROBE_TIMEOUT_MS = 2000

/**
 * Whether an IndexedDB database exists, without creating it.
 * Uses `indexedDB.databases()` where supported, and falls back to a probe when it is unavailable,
 * rejects or hangs (as in some Safari and Firefox workers).
 */
export async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') {
    return false
  }

  if (typeof indexedDB.databases === 'function') {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const dbs = await Promise.race([
        indexedDB.databases(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), DATABASES_TIMEOUT_MS)
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
      })
      if (Array.isArray(dbs)) {
        return dbs.some(db => db && db.name === name)
      }
    } catch {
      // Fall back to probing
    }
  }

  return probeDatabaseExists(name)
}

/**
 * Opens without a version and aborts the versionchange when oldVersion === 0, so a missing
 * database is never created.
 */
function probeDatabaseExists(name: string): Promise<boolean> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
      resolve(false)
      return
    }

    let isSettled = false

    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish(false)
    }, PROBE_TIMEOUT_MS)

    function finish(result: boolean, dbToClose?: IDBDatabase): void {
      if (!isSettled) {
        isSettled = true
        clearTimeout(timeoutId)
        if (dbToClose) {
          try {
            dbToClose.close()
          } catch {
            // Ignore database close error
          }
        }
        resolve(result)
      }
    }

    try {
      const request = indexedDB.open(name)

      request.onupgradeneeded = event => {
        if (event.oldVersion === 0) {
          try {
            const transaction = (event.target as IDBOpenDBRequest)?.transaction || request.transaction
            transaction?.abort()
          } catch {
            // Ignore transaction abort error
          }
          try {
            indexedDB.deleteDatabase(name)
          } catch {
            // Ignore database delete error
          }
          finish(false)
        } else {
          finish(true)
        }
      }

      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest)?.result
        finish(true, db)
      }

      request.onerror = event => {
        try {
          event.preventDefault()
          event.stopPropagation()
        } catch {
          // Ignore error cancellation failure
        }
        finish(false)
      }

      request.onblocked = () => {
        finish(true)
      }
    } catch {
      finish(false)
    }
  })
}

/**
 * What the main app needs to know about the migration app (the rest of `src/migrate/`), and the only
 * module it may import from there. See "Backwards compatibility" in docs/vault-extraction.md.
 */

export { MIN_DATA_VERSION } from '../shared/flockDataVersion'

export const MIGRATE_PATH = '/migrate/'

/** Announces the migration app taking over the vault, so the main app's tabs lock themselves */
export const MIGRATION_CHANNEL = 'flock-migration'

export type MigrationChannelMessage = { type: 'started', account: string } | { type: 'finished', account: string }

/** The account the main app sent to the migration app, kept for this tab only */
const HANDOFF_KEY = 'flock-migration-account'

/** Accounts whose migration the user chose to finish later, despite data that could not be migrated */
const DEFERRAL_KEY = 'flock-migration-deferred'
const DEFERRAL_MS = 30 * 24 * 60 * 60 * 1000

/** Sends the user to the migration app for `account` */
export function goToMigration(account: string): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, account)
  } catch {
    // The migration app falls back to the stored account
  }
  window.location.assign(MIGRATE_PATH)
}

export function readMigrationHandoff(): string | null {
  try {
    return sessionStorage.getItem(HANDOFF_KEY)
  } catch {
    return null
  }
}

function readDeferrals(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DEFERRAL_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, number> : {}
  } catch {
    return {}
  }
}

/**
 * Lets the main app skip the account-level check for a while, for an account whose remaining
 * legacy data the migration app could not convert (the items stay in manual recovery).
 */
export function deferMigration(account: string, now = Date.now()): void {
  localStorage.setItem(DEFERRAL_KEY, JSON.stringify({ ...readDeferrals(), [account]: now + DEFERRAL_MS }))
}

export function isMigrationDeferred(account: string, now = Date.now()): boolean {
  return (readDeferrals()[account] ?? 0) > now
}

/** The per-store databases Flock used until its sync metadata was consolidated (2026-09-14) */
export const LEGACY_SYNC_DATABASES = [
  'flock-sync-cursors',
  'flock-item-metadata',
  'flock-sync-last-modified',
  'flock-sync-synced-heads',
]

/**
 * Probes whether an IndexedDB database exists without creating it,
 * by opening without a version and aborting versionchange if oldVersion === 0.
 */
export function probeDatabaseExists(dbName: string): Promise<boolean> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') {
      return resolve(false)
    }

    let isSettled = false

    const timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
      finish(false)
    }, 2000)

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
      const request = indexedDB.open(dbName)

      request.onupgradeneeded = event => {
        if (event.oldVersion === 0) {
          try {
            const transaction = (event.target as IDBOpenDBRequest)?.transaction || request.transaction
            transaction?.abort()
          } catch {
            // Ignore transaction abort error
          }
          try {
            indexedDB.deleteDatabase(dbName)
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

/**
 * Checks if a legacy database exists in IndexedDB before attempting to open it,
 * preventing accidental creation of legacy databases.
 * Uses indexedDB.databases() where supported, with fallback to probeDatabaseExists()
 * when indexedDB.databases() is unavailable, rejects, or hangs (e.g. Safari/Firefox workers).
 */
export async function hasLegacyDatabase(dbName: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') {
    return false
  }

  if (typeof indexedDB.databases === 'function') {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const dbs = await Promise.race([
        indexedDB.databases(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 1500)
        }),
      ]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
      })
      if (Array.isArray(dbs)) {
        return dbs.some(db => db && db.name === dbName)
      }
    } catch {
      // indexedDB.databases() failed or timed out (common in Safari/Firefox workers);
      // fall back to probing via indexedDB.open
    }
  }

  return probeDatabaseExists(dbName)
}

/**
 * Whether this device holds sync data in a layout only the migration app reads. Checked by the
 * sync worker for a device with no data in the current layout (`SyncWorkerConfig.hasLegacyLocalData`).
 */
export async function hasLegacyLocalData(): Promise<boolean> {
  for (const name of LEGACY_SYNC_DATABASES) {
    if (await hasLegacyDatabase(name)) return true
  }
  return false
}

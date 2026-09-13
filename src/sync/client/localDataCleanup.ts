import { getAutomergeDBName } from '../worker/AutomergeRepoManager'
import { IndexStore } from '../worker/stores/IndexStore'
import { CursorStore } from '../worker/stores/CursorStore'
import { LastModifiedStore } from '../worker/stores/LastModifiedStore'
import { SyncWriteAheadLog } from '../worker/SyncWriteAheadLog'
import { clearSyncBatch } from '../shared/VaultPersistence'
import { clearManualRecoveryEntries } from '../shared/manualRecoveryStore'

export async function clearAutomergeIndexedDb(accountId: string, timeoutMs: number = 5000): Promise<void> {
  const dbName = getAutomergeDBName(accountId)
  if (typeof indexedDB === 'undefined') {
    return
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let isBlocked = false

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

    const req = indexedDB.deleteDatabase(dbName)

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (settled) return
      const errMsg = isBlocked
        ? `[SyncBridge] deleteDatabase blocked and timed out after ${timeoutMs}ms for ${dbName}`
        : `[SyncBridge] deleteDatabase timed out after ${timeoutMs}ms for ${dbName}`
      console.error(errMsg)
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
      console.error(`[SyncBridge] Error deleting IndexedDB database ${dbName}:`, req.error)
      const err = req.error || new Error(`[SyncBridge] Error deleting IndexedDB database ${dbName}`)
      cleanup()
      reject(err)
    }

    req.onblocked = () => {
      if (settled) return
      isBlocked = true
      console.warn(`[SyncBridge] deleteDatabase blocked for ${dbName}, waiting for open connections to close`)
    }
  })
}

export async function clearAccountLocalData(accountId: string): Promise<void> {
  if (!accountId) return
  try {
    await Promise.allSettled([
      clearAutomergeIndexedDb(accountId).catch(err => console.error('[SyncBridge] Failed to clear Automerge IndexedDB', err)),
      new IndexStore(accountId).clear().catch(err => console.error('[SyncBridge] Failed to clear IndexStore', err)),
      new CursorStore(accountId).clear().catch(err => console.error('[SyncBridge] Failed to clear CursorStore', err)),
      new LastModifiedStore(accountId).clear().catch(err => console.error('[SyncBridge] Failed to clear LastModifiedStore', err)),
      SyncWriteAheadLog.clear(accountId).catch(err => console.error('[SyncBridge] Failed to clear SyncWriteAheadLog', err)),
      clearSyncBatch(accountId).catch(err => console.error('[SyncBridge] Failed to clear SyncBatch', err)),
      clearManualRecoveryEntries(accountId).catch(err => console.error('[SyncBridge] Failed to clear ManualRecovery', err)),
    ])
  } catch (err) {
    console.error(`[SyncBridge] Error clearing local data for account ${accountId}:`, err)
  }
}

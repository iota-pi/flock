import localforage from 'localforage'
import { isQuotaError } from 'src/utils/storageQuota'
import { reportQuotaExceeded } from '../workers/quotaReporter'

export const syncBatchStorage = localforage.createInstance({
  name: 'FlockVault_SyncBatchDB',
  storeName: 'sync-batch-messages',
})

let isQuotaExceeded = false

export function resetQuotaExceededStatus(): void {
  isQuotaExceeded = false
}

const MAX_MESSAGES_PER_ITEM = 2000

const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Serializes database write operations on a per-key basis to prevent concurrent write corruption.
 */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) || Promise.resolve()
  const next = (async () => {
    try {
      await previous
    } catch {
      // Ignore errors from previous tasks in the queue to avoid blocking
    }
    return task()
  })()
  writeQueues.set(key, next)
  next.finally(() => {
    if (writeQueues.get(key) === next) {
      writeQueues.delete(key)
    }
  })
  return next
}

/**
 * Persists pending sync writes into the local IndexedDB storage, enforcing bounds on size.
 */
export async function persistSyncMessages(
  account: string,
  writes: Map<string, Uint8Array[]>
): Promise<void> {
  if (writes.size === 0) {
    return
  }

  if (isQuotaExceeded) {
    reportQuotaExceeded()
    return
  }

  const entries = Array.from(writes.entries())
  writes.clear()

  const promises = entries.map(([itemId, newMessages]) => {
    const key = `${account}:${itemId}`
    return enqueue(key, async () => {
      try {
        const existing: Uint8Array[] | null = await syncBatchStorage.getItem(key)
        const combined = existing ? [...existing, ...newMessages] : newMessages

        let bounded = combined
        if (combined.length > MAX_MESSAGES_PER_ITEM) {
          console.warn(
            `[VaultPersistence] Sync batch for item ${itemId} exceeded limit of ${MAX_MESSAGES_PER_ITEM} messages. Truncating to keep the latest ones.`
          )
          bounded = combined.slice(-MAX_MESSAGES_PER_ITEM)
        }

        await syncBatchStorage.setItem(key, bounded)
      } catch (err) {
        console.error(`[VaultPersistence] Failed to persist sync messages for ${itemId}`, err)
        if (isQuotaError(err)) {
          isQuotaExceeded = true
          reportQuotaExceeded()
        }
        // Put them back in the pending map so we can try again
        const existingPending = writes.get(itemId) || []
        writes.set(itemId, [...newMessages, ...existingPending])
      }
    })
  })

  await Promise.all(promises)
}

/**
 * Loads pending sync batch entries from IndexedDB for the given account.
 * Normalizes message format in case of serialized object representation.
 */
export async function loadSyncBatch(account: string): Promise<[string, Uint8Array[]][]> {
  const batchEntries: [string, Uint8Array[]][] = []
  try {
    await syncBatchStorage.iterate<(Uint8Array | object)[], void>((value, key) => {
      if (key.startsWith(`${account}:`)) {
        const itemId = key.slice(account.length + 1)
        if (value && value.length > 0) {
          const normalized = value.map(m => {
            if (m instanceof Uint8Array) {
              return m
            }
            if (m && typeof m === 'object') {
              const rawObj = m as { [index: number]: number, length: number }
              const length = Number.isFinite(rawObj.length) ? rawObj.length : Object.keys(rawObj).length
              const arr = Array.from({ ...rawObj, length }) as number[]
              return new Uint8Array(arr)
            }
            return new Uint8Array()
          })
          batchEntries.push([itemId, normalized])
        }
      }
    })
  } catch (err) {
    console.error('[VaultPersistence] Failed to load sync batch from IndexedDB', err)
    throw err
  }
  return batchEntries
}

/**
 * Transactionally updates IndexedDB to remove or slice successfully sent messages.
 */
export async function removeSentSyncMessages(
  account: string,
  chunkEntry: [string, Uint8Array[]][]
): Promise<void> {
  const promises = chunkEntry.map(([itemId, sentMessages]) => {
    const key = `${account}:${itemId}`
    const numSent = sentMessages.length
    return enqueue(key, async () => {
      try {
        const current: Uint8Array[] | null = await syncBatchStorage.getItem(key)
        if (current) {
          const remaining = current.slice(numSent)
          if (remaining.length > 0) {
            await syncBatchStorage.setItem(key, remaining)
          } else {
            await syncBatchStorage.removeItem(key)
          }
        }
      } catch (err) {
        console.error(
          `[VaultPersistence] Failed to update IndexedDB after sync for ${itemId}`,
          err
        )
      }
    })
  })

  await Promise.all(promises)
}

/**
 * Clears any pending sync batch messages for a specific account.
 */
export async function clearSyncBatch(account: string): Promise<void> {
  const keysToRemove: string[] = []
  try {
    await syncBatchStorage.iterate<unknown, void>((_, key) => {
      if (key.startsWith(`${account}:`)) {
        keysToRemove.push(key)
      }
    })
    await Promise.all(keysToRemove.map(key => syncBatchStorage.removeItem(key)))
  } catch (err) {
    console.error(`[VaultPersistence] Failed to clear sync batch for ${account}`, err)
    throw err
  }
}

/**
 * Restores pending sync batch entries to IndexedDB for the given account.
 */
export async function restoreSyncBatch(
  account: string,
  pendingSync: [string, Uint8Array[]][]
): Promise<void> {
  try {
    await clearSyncBatch(account)
    await Promise.all(
      pendingSync.map(([itemId, messages]) => {
        const key = `${account}:${itemId}`
        return syncBatchStorage.setItem(key, messages)
      })
    )
  } catch (err) {
    console.error(`[VaultPersistence] Failed to restore sync batch for ${account}`, err)
    throw err
  }
}

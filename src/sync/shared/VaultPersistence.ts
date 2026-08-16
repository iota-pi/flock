import localforage from 'localforage'
import { ItemId } from 'src/shared/schemas/items'
import {
  runStorageOperation,
  checkQuotaExceeded,
  resetQuotaExceededStatus,
} from '../../utils/storageManager'

export { resetQuotaExceededStatus }

const storageInstances = new Map<string, LocalForage>()

export function getSyncBatchStorage(accountId: string): LocalForage {
  let instance = storageInstances.get(accountId)
  if (!instance) {
    instance = localforage.createInstance({
      name: `FlockVault_SyncBatchDB_${accountId}`,
      storeName: 'sync-batch-messages',
    })
    storageInstances.set(accountId, instance)
  }
  return instance
}

export function clearInstancesCacheForTesting(): void {
  storageInstances.clear()
}

const MAX_MESSAGES_PER_ITEM = 2000

const writeQueues = new Map<string, Promise<unknown>>()

/**
 * Serializes database write operations on a per-key basis to prevent concurrent write corruption.
 * The queue key uses compound `${account}:${itemId}` to avoid cross-account serialization collisions.
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

  if (checkQuotaExceeded()) {
    return
  }

  const entries = Array.from(writes.entries())
  writes.clear()

  const storage = getSyncBatchStorage(account)

  const promises = entries.map(([itemId, newMessages]) => {
    const queueKey = `${account}:${itemId}`
    return enqueue(queueKey, async () => {
      try {
        const existing: Uint8Array[] | null = await storage.getItem(itemId)
        const combined = existing ? [...existing, ...newMessages] : newMessages

        let bounded = combined
        if (combined.length > MAX_MESSAGES_PER_ITEM) {
          console.warn(
            `[VaultPersistence] Sync batch for item ${itemId} exceeded limit of ${MAX_MESSAGES_PER_ITEM} messages. Truncating to keep the latest ones.`
          )
          bounded = combined.slice(-MAX_MESSAGES_PER_ITEM)
        }

        await runStorageOperation(() => storage.setItem(itemId, bounded))
      } catch (err) {
        console.error(`[VaultPersistence] Failed to persist sync messages for ${itemId}`, err)
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
export async function loadSyncBatch(account: string): Promise<[ItemId, Uint8Array[]][]> {
  const batchEntries: [ItemId, Uint8Array[]][] = []
  const storage = getSyncBatchStorage(account)
  try {
    await storage.iterate<(Uint8Array | object)[], void>((value, itemId) => {
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
        batchEntries.push([itemId as ItemId, normalized])
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
  chunkEntry: [ItemId, Uint8Array[]][]
): Promise<void> {
  const storage = getSyncBatchStorage(account)
  const promises = chunkEntry.map(([itemId, sentMessages]) => {
    const queueKey = `${account}:${itemId}`
    const numSent = sentMessages.length
    return enqueue(queueKey, async () => {
      try {
        const current: Uint8Array[] | null = await storage.getItem(itemId)
        if (current) {
          const remaining = current.slice(numSent)
          if (remaining.length > 0) {
            await storage.setItem(itemId, remaining)
          } else {
            await storage.removeItem(itemId)
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
 * Serializes removals through the per-key write queue to avoid race conditions with in-flight persists.
 */
export async function clearSyncBatch(account: string): Promise<void> {
  try {
    const storage = getSyncBatchStorage(account)
    const dbKeys = await storage.keys()
    const prefix = `${account}:`
    const activeKeys = Array.from(writeQueues.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))

    const allKeys = new Set([...dbKeys, ...activeKeys])

    await Promise.all(
      Array.from(allKeys).map(itemId => {
        const queueKey = `${account}:${itemId}`
        return enqueue(queueKey, () => storage.removeItem(itemId))
      })
    )
  } catch (err) {
    console.error(`[VaultPersistence] Failed to clear sync batch for ${account}`, err)
    throw err
  }
}

/**
 * Restores pending sync batch entries to IndexedDB for the given account.
 * Serializes operations through the per-key write queue to ensure state consistency with concurrent persists.
 */
export async function restoreSyncBatch(
  account: string,
  pendingSync: [ItemId, Uint8Array[]][]
): Promise<void> {
  try {
    const storage = getSyncBatchStorage(account)
    const dbKeys = await storage.keys()
    const prefix = `${account}:`
    const activeKeys = Array.from(writeQueues.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))

    const pendingMap = new Map<string, Uint8Array[]>(pendingSync)
    const allKeys = new Set([...dbKeys, ...activeKeys, ...pendingMap.keys()])

    await Promise.all(
      Array.from(allKeys).map(itemId => {
        const queueKey = `${account}:${itemId}`
        return enqueue(queueKey, async () => {
          if (pendingMap.has(itemId)) {
            await storage.setItem(itemId, pendingMap.get(itemId)!)
          } else {
            await storage.removeItem(itemId)
          }
        })
      })
    )
  } catch (err) {
    console.error(`[VaultPersistence] Failed to restore sync batch for ${account}`, err)
    throw err
  }
}

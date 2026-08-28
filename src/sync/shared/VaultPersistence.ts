import localforage from 'localforage'
import { nanoid } from 'nanoid'
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

export interface QueuedMessage {
  id: string
  data: Uint8Array
}

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data && typeof data === 'object') {
    const rawObj = data as Record<string | number, unknown>
    const length = typeof rawObj.length === 'number' && Number.isFinite(rawObj.length)
      ? rawObj.length
      : Object.keys(rawObj).length
    const arr: number[] = []
    for (let i = 0; i < length; i++) {
      const val = rawObj[i]
      arr.push(typeof val === 'number' ? val : 0)
    }
    return new Uint8Array(arr)
  }
  return new Uint8Array()
}

function normalizeMessage(m: unknown): { msg: QueuedMessage; wasModified: boolean } {
  if (m instanceof Uint8Array) {
    return { msg: { id: nanoid(), data: m }, wasModified: true }
  }

  if (m && typeof m === 'object' && 'id' in m && 'data' in m) {
    const obj = m as { id: unknown; data: unknown }
    const id = typeof obj.id === 'string' ? obj.id : nanoid()
    const isDataValidUint8Array = obj.data instanceof Uint8Array
    const data = toUint8Array(obj.data)
    const wasModified = !isDataValidUint8Array || id !== obj.id
    return { msg: { id, data }, wasModified }
  }

  if (m && typeof m === 'object') {
    return { msg: { id: nanoid(), data: toUint8Array(m) }, wasModified: true }
  }

  return { msg: { id: nanoid(), data: new Uint8Array() }, wasModified: true }
}

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
        const existing: unknown[] | null = await storage.getItem<unknown[]>(itemId)
        const normalizedExisting = existing ? existing.map(m => normalizeMessage(m).msg) : []
        const newWrapped: QueuedMessage[] = newMessages.map(m => ({
          id: nanoid(),
          data: m,
        }))
        const combined = [...normalizedExisting, ...newWrapped]

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
      }
    })
  })

  await Promise.all(promises)
}

/**
 * Loads pending sync batch entries from IndexedDB for the given account.
 * Normalizes message format in case of serialized object representation.
 */
export async function loadSyncBatch(account: string): Promise<[ItemId, QueuedMessage[]][]> {
  const batchEntries: [ItemId, QueuedMessage[]][] = []
  const storage = getSyncBatchStorage(account)
  try {
    const dbKeys = await storage.keys()
    const prefix = `${account}:`
    const activeKeys = Array.from(writeQueues.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => k.slice(prefix.length))

    const allKeys = new Set([...dbKeys, ...activeKeys])

    await Promise.all(
      Array.from(allKeys).map(itemId => {
        const queueKey = `${account}:${itemId}`
        return enqueue(queueKey, async () => {
          const value = await storage.getItem<unknown[]>(itemId)
          if (value && value.length > 0) {
            let needsSave = false
            const normalized = value.map(m => {
              const res = normalizeMessage(m)
              if (res.wasModified) {
                needsSave = true
              }
              return res.msg
            })
            if (needsSave) {
              await storage.setItem(itemId, normalized)
            }
            batchEntries.push([itemId as ItemId, normalized])
          }
        })
      })
    )
  } catch (err) {
    console.error('[VaultPersistence] Failed to load sync batch from IndexedDB', err)
    throw err
  }
  return batchEntries
}

/**
 * Transactionally updates IndexedDB to remove successfully sent messages by their IDs.
 */
export async function removeSentSyncMessages(
  account: string,
  chunkEntry: [ItemId, QueuedMessage[]][]
): Promise<void> {
  const storage = getSyncBatchStorage(account)
  const promises = chunkEntry.map(([itemId, sentMessages]) => {
    const queueKey = `${account}:${itemId}`
    const sentIds = new Set(sentMessages.map(m => m.id))
    return enqueue(queueKey, async () => {
      try {
        const current: unknown[] | null = await storage.getItem<unknown[]>(itemId)
        if (current) {
          const normalized = current.map(m => normalizeMessage(m).msg)
          const remaining = normalized.filter(m => !sentIds.has(m.id))
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
    const pendingMap = new Map<string, Uint8Array[]>(pendingSync)

    await Promise.all(
      Array.from(pendingMap.entries()).map(([itemId, messages]) => {
        const queueKey = `${account}:${itemId}`
        return enqueue(queueKey, async () => {
          const wrapped: QueuedMessage[] = messages.map(m => ({
            id: nanoid(),
            data: m,
          }))
          await storage.setItem(itemId, wrapped)
        })
      })
    )
  } catch (err) {
    console.error(`[VaultPersistence] Failed to restore sync batch for ${account}`, err)
    throw err
  }
}

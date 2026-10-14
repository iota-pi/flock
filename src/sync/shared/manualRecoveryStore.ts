import { runStorageOperation } from '../../utils/storageManager'
import { KeyedAsyncMutex } from '../utils/AsyncMutex'
import { ItemId } from 'src/shared/schemas/items'
import {
  createAccountStore,
  clearAccountStoreInstancesCacheForTesting,
} from './createAccountStore'
import {
  getSyncMetadataStorage,
  SYNC_METADATA_KEYS,
  LEGACY_KEYS,
  clearSyncMetadataInstancesCacheForTesting,
} from '../worker/stores/syncMetadataStorage'

const STORE_NAME = 'manual-recovery-items'

export const MANUAL_RECOVERY_KINDS = [
  'pullDecryption',
  'snapshotDecryption',
  'oversized',
  'snapshotFailure',
  'pushFailure',
  'unknown',
] as const
export type ManualRecoveryKind = typeof MANUAL_RECOVERY_KINDS[number]

export type ManualRecoveryEntry = {
  id: string
  itemId: ItemId
  reason: string
  kind: ManualRecoveryKind
  createdAt: number
}

// Entries persisted before `kind` existed may lack it (or hold garbage)
type StoredManualRecoveryEntry = Omit<ManualRecoveryEntry, 'kind'> & { kind?: unknown }

const entryMutex = new KeyedAsyncMutex<string>()

function entryLockKey(accountId: string, itemId: string): string {
  return `${accountId}:${itemId}`
}

function isManualRecoveryKind(value: unknown): value is ManualRecoveryKind {
  return typeof value === 'string' && (MANUAL_RECOVERY_KINDS as readonly string[]).includes(value)
}

export function inferLegacyManualRecoveryKind(reason: string): ManualRecoveryKind {
  const text = reason.toLowerCase()
  if (text.includes('exceeds') && text.includes('kb limit')) return 'oversized'
  if (text.includes('push failed after')) return 'pushFailure'
  if (text.includes('snapshot failure:') || text.includes('re-encryption')) return 'snapshotFailure'
  if (
    text.includes('corrupted branches:')
    || text.includes('automated recovery is unavailable')
    || text.includes('decrypt')
    || text.includes('failed to parse')
  ) {
    return 'pullDecryption'
  }
  return 'unknown'
}

export function normalizeManualRecoveryEntry(value: unknown): ManualRecoveryEntry | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as StoredManualRecoveryEntry
  if (
    typeof stored.id !== 'string'
    || typeof stored.itemId !== 'string'
    || typeof stored.reason !== 'string'
    || typeof stored.createdAt !== 'number'
  ) {
    return null
  }
  const kind = isManualRecoveryKind(stored.kind) ? stored.kind : inferLegacyManualRecoveryKind(stored.reason)
  return { ...stored, kind }
}

function kindRank(kind: ManualRecoveryKind): number {
  if (kind === 'pullDecryption') return 0
  if (kind === 'oversized') return 2
  return 1
}

function getManualRecoveryStorage(accountId: string) {
  return createAccountStore(STORE_NAME, accountId)
}

function getLegacyManualRecoveryMetaStorage(accountId: string) {
  return createAccountStore('manual-recovery-metadata', accountId)
}

const migrationPromisesByAccount = new Map<string, Promise<void>>()

export function resetMigrationForTesting(): void {
  migrationPromisesByAccount.clear()
}

export function clearInstancesCacheForTesting(): void {
  clearAccountStoreInstancesCacheForTesting()
  clearSyncMetadataInstancesCacheForTesting()
}

async function runMigration(accountId: string): Promise<void> {
  const storage = getManualRecoveryStorage(accountId)
  const metaStorage = getSyncMetadataStorage(accountId)
  try {
    const migrated = await metaStorage.getItem<boolean>(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED)
    if (migrated) {
      return
    }

    // Check legacy manual-recovery-metadata store for backward compatibility
    try {
      const legacyMetaStorage = getLegacyManualRecoveryMetaStorage(accountId)
      const legacyMigrated = await legacyMetaStorage.getItem<boolean>(LEGACY_KEYS.MANUAL_RECOVERY_MIGRATED)
      if (legacyMigrated) {
        await runStorageOperation(() => metaStorage.setItem(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED, true))
        await runStorageOperation(() => legacyMetaStorage.clear()).catch(() => {})
        return
      }
    } catch {
      // Ignore legacy metadata store lookup errors
    }

    const keys = await storage.keys()
    const entriesByItemId = new Map<ItemId, StoredManualRecoveryEntry[]>()
    const keysToRemove = new Set<string>()

    for (const key of keys) {
      const value = await storage.getItem<StoredManualRecoveryEntry>(key)
      if (value && typeof value === 'object' && typeof value.itemId === 'string') {
        const list = entriesByItemId.get(value.itemId) ?? []
        list.push(value)
        entriesByItemId.set(value.itemId, list)
        if (key !== value.itemId) {
          keysToRemove.add(key)
        }
      } else {
        keysToRemove.add(key)
      }
    }

    for (const [itemId, entries] of entriesByItemId.entries()) {
      if (entries.length === 1) {
        const single = entries[0]
        const newItem: StoredManualRecoveryEntry = {
          ...single,
          id: itemId,
        }
        await runStorageOperation(() => storage.setItem(itemId, newItem))
      } else {
        // Sort chronologically ascending to preserve order of reasons
        entries.sort((a, b) => a.createdAt - b.createdAt)
        const uniqueReasons: string[] = []
        for (const entry of entries) {
          if (entry.reason && typeof entry.reason === 'string') {
            const trimmed = entry.reason.trim()
            if (trimmed && !uniqueReasons.includes(trimmed)) {
              uniqueReasons.push(trimmed)
            }
          }
        }
        const combinedReason = uniqueReasons.join('; ') || 'Manual recovery required'
        const latestCreatedAt = Math.max(...entries.map(e => e.createdAt || 0))

        const mergedEntry: StoredManualRecoveryEntry = {
          id: itemId,
          itemId,
          reason: combinedReason,
          createdAt: latestCreatedAt > 0 ? latestCreatedAt : Date.now(),
        }
        await runStorageOperation(() => storage.setItem(itemId, mergedEntry))
      }
    }

    for (const key of keysToRemove) {
      await runStorageOperation(() => storage.removeItem(key))
    }

    await runStorageOperation(() => metaStorage.setItem(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED, true))

    // Clean up legacy metadata store if it exists
    try {
      const legacyMetaStorage = getLegacyManualRecoveryMetaStorage(accountId)
      await runStorageOperation(() => legacyMetaStorage.clear()).catch(() => {})
    } catch {
      // Ignore cleanup error
    }
  } catch (error) {
    console.error('[ManualRecoveryStore] Migration failed', error)
    throw error
  }
}

async function ensureMigrated(accountId: string): Promise<void> {
  let promise = migrationPromisesByAccount.get(accountId)
  if (!promise) {
    promise = runMigration(accountId).catch(error => {
      migrationPromisesByAccount.delete(accountId)
      throw error
    })
    migrationPromisesByAccount.set(accountId, promise)
  }
  return promise
}

export const DEFAULT_MANUAL_RECOVERY_LIMIT = 100
export const MAX_MANUAL_RECOVERY_LIMIT = 500

export interface ReadManualRecoveryOptions {
  limit?: number
  offset?: number
}

function sortEntries(left: ManualRecoveryEntry, right: ManualRecoveryEntry): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }

  return left.id.localeCompare(right.id)
}

function insertSorted(candidates: ManualRecoveryEntry[], entry: ManualRecoveryEntry, maxCapacity: number): void {
  if (candidates.length === 0) {
    candidates.push(entry)
    return
  }

  let low = 0
  let high = candidates.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sortEntries(entry, candidates[mid]) < 0) {
      high = mid
    } else {
      low = mid + 1
    }
  }

  candidates.splice(low, 0, entry)
  if (candidates.length > maxCapacity) {
    candidates.pop()
  }
}

export async function readManualRecoveryEntries(
  accountId: string,
  options?: ReadManualRecoveryOptions,
): Promise<ManualRecoveryEntry[]> {
  if (!accountId) return []
  await ensureMigrated(accountId)

  const limit = Math.min(
    Math.max(options?.limit ?? DEFAULT_MANUAL_RECOVERY_LIMIT, 1),
    MAX_MANUAL_RECOVERY_LIMIT,
  )
  const offset = Math.max(options?.offset ?? 0, 0)
  const maxNeeded = offset + limit

  const candidates: ManualRecoveryEntry[] = []
  const storage = getManualRecoveryStorage(accountId)

  await storage.iterate<unknown, void>(raw => {
    const value = normalizeManualRecoveryEntry(raw)
    if (value) {
      if (candidates.length < maxNeeded) {
        insertSorted(candidates, value, maxNeeded)
      } else if (sortEntries(value, candidates[candidates.length - 1]) < 0) {
        insertSorted(candidates, value, maxNeeded)
      }
    }
  })

  return candidates.slice(offset, offset + limit)
}

export async function readManualRecoveryCount(accountId: string): Promise<number> {
  if (!accountId) return 0
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  return storage.length()
}

export async function upsertManualRecoveryEntry(
  accountId: string,
  input: {
    itemId: ItemId
    reason: string
    kind: ManualRecoveryKind
  }
): Promise<ManualRecoveryEntry> {
  if (!accountId) throw new Error('accountId is required')
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  return entryMutex.runExclusive(entryLockKey(accountId, input.itemId), async () => {
    const existing = normalizeManualRecoveryEntry(await storage.getItem<unknown>(input.itemId))
    // A weaker quarantine must not replace a stronger one (e.g. oversized)
    if (existing && kindRank(input.kind) < kindRank(existing.kind)) {
      return existing
    }

    const entry: ManualRecoveryEntry = {
      id: input.itemId,
      itemId: input.itemId,
      reason: input.reason,
      kind: input.kind,
      createdAt: Date.now(),
    }
    await runStorageOperation(() => storage.setItem(entry.id, entry))
    return entry
  })
}

export async function removeManualRecoveryEntryIfKind(
  accountId: string,
  itemId: ItemId,
  kinds: ReadonlySet<ManualRecoveryKind>,
): Promise<boolean> {
  if (!accountId) return false
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  return entryMutex.runExclusive(entryLockKey(accountId, itemId), async () => {
    const existing = normalizeManualRecoveryEntry(await storage.getItem<unknown>(itemId))
    if (!existing || !kinds.has(existing.kind)) return false
    await runStorageOperation(() => storage.removeItem(itemId))
    return true
  })
}

export async function removeManualRecoveryEntryByItemId(accountId: string, itemId: ItemId): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await entryMutex.runExclusive(entryLockKey(accountId, itemId), () => (
    runStorageOperation(() => storage.removeItem(itemId))
  ))
}

export async function removeManualRecoveryEntryById(accountId: string, id: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await entryMutex.runExclusive(entryLockKey(accountId, id), () => (
    runStorageOperation(() => storage.removeItem(id))
  ))
}

export async function clearManualRecoveryEntries(accountId: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await runStorageOperation(() => storage.clear())
}

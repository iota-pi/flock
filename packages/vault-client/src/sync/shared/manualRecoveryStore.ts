import { runStorageOperation } from '../utils/storageManager'
import { KeyedAsyncMutex } from '../utils/AsyncMutex'
import { ItemId } from '@vault/shared'
import { createAccountStore } from './createAccountStore'

const STORE_NAME = 'manual-recovery-items'

const MANUAL_RECOVERY_KINDS = [
  'pullDecryption',
  'snapshotDecryption',
  'oversized',
  'snapshotFailure',
  'pushFailure',
  'localDecryption',
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

/**
 * Infers the kind of an entry stored before `kind` existed, from its reason text. Such entries can sit in
 * IndexedDB indefinitely (they're only removed once the item recovers or the user dismisses them), so this
 * stays in the library rather than the migration app: without it they'd all read as 'unknown', and `kindRank`
 * and `removeManualRecoveryEntryIfKind` would treat a real quarantine (oversized, say) as replaceable.
 */
function inferLegacyManualRecoveryKind(reason: string): ManualRecoveryKind {
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

function normalizeManualRecoveryEntry(value: unknown): ManualRecoveryEntry | null {
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
  // The local document can't be read at all, which no other problem with it overrides
  if (kind === 'localDecryption') return 3
  return 1
}

function getManualRecoveryStorage(accountId: string) {
  return createAccountStore(STORE_NAME, accountId)
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
  const storage = getManualRecoveryStorage(accountId)
  await entryMutex.runExclusive(entryLockKey(accountId, itemId), () => (
    runStorageOperation(() => storage.removeItem(itemId))
  ))
}

export async function removeManualRecoveryEntryById(accountId: string, id: string): Promise<void> {
  if (!accountId) return
  const storage = getManualRecoveryStorage(accountId)
  await entryMutex.runExclusive(entryLockKey(accountId, id), () => (
    runStorageOperation(() => storage.removeItem(id))
  ))
}

export async function clearManualRecoveryEntries(accountId: string): Promise<void> {
  if (!accountId) return
  const storage = getManualRecoveryStorage(accountId)
  await runStorageOperation(() => storage.clear())
}

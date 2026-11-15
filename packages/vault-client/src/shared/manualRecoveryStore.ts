import { runStorageOperation } from '../utils/storageManager'
import { KeyedAsyncMutex } from '../utils/AsyncMutex'
import { type ItemId, MAX_ITEM_SIZE_KB } from '@vault/shared'
import { createAccountStore } from './createAccountStore'

const STORE_NAME = 'manual-recovery-items'

const MANUAL_RECOVERY_KINDS = [
  'pullDecryption',
  'snapshotDecryption',
  'oversized',
  'snapshotFailure',
  'pushFailure',
  'localDecryption',
  'missingChanges',
  'unknown',
] as const
export type ManualRecoveryKind = typeof MANUAL_RECOVERY_KINDS[number]

export type ManualRecoveryStage = 'build' | 'upload'

/**
 * Why an item was quarantined, from a fixed set holding only codes and numbers. The store is unsealed
 * (docs/local-encryption.md), so it never holds free text: an error message can quote decrypted content.
 */
export type ManualRecoveryDetail =
  | { code: 'decryptionFailed' }
  | { code: 'hydrationFailed' }
  | { code: 'oversized'; sizeKb: number }
  | { code: 'snapshotFailed'; stage: ManualRecoveryStage }
  | { code: 'reencryptionFailed'; stage: ManualRecoveryStage }
  | { code: 'waitingForChanges' }
  | { code: 'snapshotNeverStored' }
  | { code: 'keyVersionMissing' }
  | { code: 'changesNeverArrived' }
  | { code: 'unspecified' }

export type ManualRecoveryEntry = {
  id: string
  itemId: ItemId
  /** Display text built from `detail` when the entry is read; it isn't stored */
  reason: string
  detail: ManualRecoveryDetail
  kind: ManualRecoveryKind
  createdAt: number
  /**
   * The server-assigned version that failed (e.g. a snapshot that couldn't be decrypted). Manifest sync
   * re-fetches the item only once the server has a newer version. Entries stored before this existed lack it.
   */
  serverVersion?: number
}

type PersistedManualRecoveryEntry = Omit<ManualRecoveryEntry, 'reason'>

/**
 * Entries persisted before `kind`, `detail` or `serverVersion` existed may lack them (or hold garbage), and
 * older ones hold a free-text `reason`, which is used only to infer their kind and is then scrubbed.
 */
type StoredManualRecoveryEntry = Pick<ManualRecoveryEntry, 'id' | 'itemId' | 'createdAt'> & {
  reason?: unknown
  detail?: unknown
  kind?: unknown
  serverVersion?: unknown
}

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

function isValidServerVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStage(value: unknown): value is ManualRecoveryStage {
  return value === 'build' || value === 'upload'
}

const UNSPECIFIED_DETAIL: ManualRecoveryDetail = { code: 'unspecified' }

/**
 * Rebuilds a detail from only the fields its code allows, so nothing else stored alongside it survives.
 * Anything unrecognised becomes `unspecified`.
 */
export function sanitizeManualRecoveryDetail(value: unknown): ManualRecoveryDetail {
  if (!value || typeof value !== 'object') return UNSPECIFIED_DETAIL
  const detail = value as Record<string, unknown>
  switch (detail.code) {
    case 'decryptionFailed':
    case 'hydrationFailed':
    case 'waitingForChanges':
    case 'snapshotNeverStored':
    case 'keyVersionMissing':
    case 'changesNeverArrived':
    case 'unspecified':
      return { code: detail.code }
    case 'oversized':
      return isNonNegativeInteger(detail.sizeKb) ? { code: 'oversized', sizeKb: detail.sizeKb } : UNSPECIFIED_DETAIL
    case 'snapshotFailed':
    case 'reencryptionFailed':
      return isStage(detail.stage) ? { code: detail.code, stage: detail.stage } : UNSPECIFIED_DETAIL
    default:
      return UNSPECIFIED_DETAIL
  }
}

export function describeManualRecoveryDetail(detail: ManualRecoveryDetail): string {
  switch (detail.code) {
    case 'decryptionFailed':
      return 'Automated recovery is unavailable for this revision'
    case 'hydrationFailed':
      return 'The item\'s snapshot from the server repeatedly failed to load'
    case 'oversized':
      return `Snapshot size (${detail.sizeKb} KB) exceeds ${MAX_ITEM_SIZE_KB} KB limit. `
        + 'Recreating the item with fresh history is required to resume sync.'
    case 'snapshotFailed':
      return `Snapshot ${detail.stage} failed repeatedly. Changes are stored locally only.`
    case 'reencryptionFailed':
      return detail.stage === 'build' ? 'Re-encryption snapshot build failed' : 'Re-encryption upload failed'
    case 'waitingForChanges':
      return 'Waiting for changes from another device'
    case 'snapshotNeverStored':
      return 'This device\'s snapshot of the item was never stored'
    case 'keyVersionMissing':
      return 'The key version for the item\'s heads never arrived'
    case 'changesNeverArrived':
      return 'The item never received the changes the server\'s snapshot holds'
    case 'unspecified':
      return 'Auto-recovery exhausted all options.'
  }
}

function normalizeManualRecoveryEntry(value: unknown): ManualRecoveryEntry | null {
  if (!value || typeof value !== 'object') return null
  const stored = value as StoredManualRecoveryEntry
  if (
    typeof stored.id !== 'string'
    || typeof stored.itemId !== 'string'
    || typeof stored.createdAt !== 'number'
  ) {
    return null
  }
  let kind: ManualRecoveryKind
  if (isManualRecoveryKind(stored.kind)) {
    kind = stored.kind
  } else if (typeof stored.reason === 'string') {
    kind = inferLegacyManualRecoveryKind(stored.reason)
  } else {
    kind = 'unknown'
  }
  const detail = sanitizeManualRecoveryDetail(stored.detail)
  return {
    id: stored.id,
    itemId: stored.itemId as ItemId,
    reason: describeManualRecoveryDetail(detail),
    detail,
    kind,
    createdAt: stored.createdAt,
    ...(isValidServerVersion(stored.serverVersion) ? { serverVersion: stored.serverVersion } : {}),
  }
}

function toPersisted(entry: ManualRecoveryEntry): PersistedManualRecoveryEntry {
  const { reason: _reason, ...persisted } = entry
  return persisted
}

/** Whether a stored entry still holds a free-text reason, or anything else a clean entry wouldn't */
function needsScrub(raw: unknown, normalized: ManualRecoveryEntry): boolean {
  if (!raw || typeof raw !== 'object') return false
  const stored = raw as Record<string, unknown>
  if ('reason' in stored) return true
  const persisted: Record<string, unknown> = toPersisted(normalized)
  return Object.keys(stored).some(key => !(key in persisted))
    || JSON.stringify(stored.detail) !== JSON.stringify(normalized.detail)
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
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
  const toScrub: string[] = []
  const storage = getManualRecoveryStorage(accountId)

  await storage.iterate<unknown, void>((raw, key) => {
    const value = normalizeManualRecoveryEntry(raw)
    if (value) {
      if (needsScrub(raw, value)) toScrub.push(key)
      if (candidates.length < maxNeeded) {
        insertSorted(candidates, value, maxNeeded)
      } else if (sortEntries(value, candidates[candidates.length - 1]) < 0) {
        insertSorted(candidates, value, maxNeeded)
      }
    }
  })

  for (const key of toScrub) {
    await scrubManualRecoveryEntry(accountId, key)
  }

  return candidates.slice(offset, offset + limit)
}

/** Rewrites an entry stored with a free-text reason (or other stray fields) in its clean form */
async function scrubManualRecoveryEntry(accountId: string, key: string): Promise<void> {
  const storage = getManualRecoveryStorage(accountId)
  await entryMutex.runExclusive(entryLockKey(accountId, key), async () => {
    const raw = await storage.getItem<unknown>(key)
    const value = normalizeManualRecoveryEntry(raw)
    if (!value || !needsScrub(raw, value)) return
    await runStorageOperation(() => storage.setItem(key, toPersisted(value)))
  })
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
    detail: ManualRecoveryDetail
    kind: ManualRecoveryKind
    serverVersion?: number
  }
): Promise<ManualRecoveryEntry> {
  if (!accountId) throw new Error('accountId is required')
  const storage = getManualRecoveryStorage(accountId)
  return entryMutex.runExclusive(entryLockKey(accountId, input.itemId), async () => {
    const raw = await storage.getItem<unknown>(input.itemId)
    const existing = normalizeManualRecoveryEntry(raw)
    // Keep the newest failed server version across kinds, so manifest sync keeps waiting for a newer one
    const serverVersion = maxDefined(input.serverVersion, existing?.serverVersion)
    // A weaker quarantine must not replace a stronger one (e.g. oversized)
    if (existing && kindRank(input.kind) < kindRank(existing.kind)) {
      if (serverVersion === existing.serverVersion && !needsScrub(raw, existing)) return existing
      const updated: ManualRecoveryEntry = { ...existing, serverVersion }
      await runStorageOperation(() => storage.setItem(updated.id, toPersisted(updated)))
      return updated
    }

    // Sanitised here too, since callers' types don't stop a detail built from untyped data
    const detail = sanitizeManualRecoveryDetail(input.detail)
    const entry: ManualRecoveryEntry = {
      id: input.itemId,
      itemId: input.itemId,
      reason: describeManualRecoveryDetail(detail),
      detail,
      kind: input.kind,
      createdAt: Date.now(),
      ...(serverVersion !== undefined ? { serverVersion } : {}),
    }
    await runStorageOperation(() => storage.setItem(entry.id, toPersisted(entry)))
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

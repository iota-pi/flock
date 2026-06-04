import localforage from 'localforage'
import { isQuotaError } from 'src/utils/storageQuota'
import { reportQuotaExceeded } from '../workers/quotaReporter'

const STORE_NAME = 'manual-recovery-items'

export type ManualRecoveryEntry = {
  id: string
  itemId: string
  reason: string
  createdAt: number
}

const manualRecoveryStorage = localforage.createInstance({
  name: 'FlockVault_ManualRecoveryDB',
  storeName: STORE_NAME,
})

const manualRecoveryMetaStorage = localforage.createInstance({
  name: 'FlockVault_ManualRecoveryDB',
  storeName: 'manual-recovery-metadata',
})

let migrationPromise: Promise<void> | null = null

export function resetMigrationForTesting(): void {
  migrationPromise = null
}

async function runMigration(): Promise<void> {
  try {
    const migrated = await manualRecoveryMetaStorage.getItem<boolean>('__migrated_v2')
    if (migrated) {
      return
    }

    const keys = await manualRecoveryStorage.keys()
    for (const key of keys) {
      const value = await manualRecoveryStorage.getItem<ManualRecoveryEntry>(key)
      if (value && typeof value === 'object' && typeof value.itemId === 'string') {
        const newItem: ManualRecoveryEntry = {
          ...value,
          id: value.itemId,
        }
        await manualRecoveryStorage.setItem(value.itemId, newItem)
        if (key !== value.itemId) {
          await manualRecoveryStorage.removeItem(key)
        }
      } else {
        await manualRecoveryStorage.removeItem(key)
      }
    }
    await manualRecoveryMetaStorage.setItem('__migrated_v2', true)
  } catch (error) {
    console.error('[ManualRecoveryStore] Migration failed', error)
  }
}

async function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigration()
  }
  return migrationPromise
}

function sortEntries(left: ManualRecoveryEntry, right: ManualRecoveryEntry): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }

  return left.id.localeCompare(right.id)
}

export async function readManualRecoveryEntries(): Promise<ManualRecoveryEntry[]> {
  await ensureMigrated()
  const entries: ManualRecoveryEntry[] = []

  await manualRecoveryStorage.iterate<ManualRecoveryEntry, void>(value => {
    if (
      value
      && typeof value === 'object'
      && typeof value.id === 'string'
      && typeof value.itemId === 'string'
      && typeof value.reason === 'string'
      && typeof value.createdAt === 'number'
    ) {
      entries.push(value)
    }
  })

  entries.sort(sortEntries)
  return entries
}

export async function readManualRecoveryCount(): Promise<number> {
  await ensureMigrated()
  return manualRecoveryStorage.length()
}

export async function upsertManualRecoveryEntry(input: {
  itemId: string
  reason: string
}): Promise<ManualRecoveryEntry> {
  await ensureMigrated()
  const existing = await manualRecoveryStorage.getItem<ManualRecoveryEntry>(input.itemId)
  const entry: ManualRecoveryEntry = existing || {
    id: input.itemId,
    itemId: input.itemId,
    reason: input.reason,
    createdAt: Date.now(),
  }

  if (existing) {
    entry.reason = input.reason
    entry.createdAt = Date.now()
  }

  try {
    await manualRecoveryStorage.setItem(entry.id, entry)
  } catch (error) {
    if (isQuotaError(error)) {
      reportQuotaExceeded()
    }
    throw error
  }
  return entry
}

export async function removeManualRecoveryEntryByItemId(itemId: string): Promise<void> {
  await ensureMigrated()
  await manualRecoveryStorage.removeItem(itemId)
}

export async function removeManualRecoveryEntryById(id: string): Promise<void> {
  await ensureMigrated()
  await manualRecoveryStorage.removeItem(id)
}

export async function clearManualRecoveryEntries(): Promise<void> {
  await ensureMigrated()
  await manualRecoveryStorage.clear()
}

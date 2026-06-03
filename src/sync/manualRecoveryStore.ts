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
  name: 'FlockVaultDB',
  storeName: STORE_NAME,
})

function createEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sortEntries(left: ManualRecoveryEntry, right: ManualRecoveryEntry): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }

  return left.id.localeCompare(right.id)
}

export async function readManualRecoveryEntries(): Promise<ManualRecoveryEntry[]> {
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
  return manualRecoveryStorage.length()
}

export async function upsertManualRecoveryEntry(input: {
  itemId: string
  reason: string
}): Promise<ManualRecoveryEntry> {
  const existing = (await readManualRecoveryEntries()).find(entry => entry.itemId === input.itemId)
  const entry: ManualRecoveryEntry = existing || {
    id: createEntryId(),
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
  const entries = await readManualRecoveryEntries()
  const target = entries.find(entry => entry.itemId === itemId)
  if (!target) {
    return
  }

  await manualRecoveryStorage.removeItem(target.id)
}

export async function removeManualRecoveryEntryById(id: string): Promise<void> {
  await manualRecoveryStorage.removeItem(id)
}

export async function clearManualRecoveryEntries(): Promise<void> {
  await manualRecoveryStorage.clear()
}

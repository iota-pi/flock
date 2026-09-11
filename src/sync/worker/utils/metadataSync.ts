import deepEqual from 'fast-deep-equal'
import type { AccountMetadata } from '../../../state/metadata'
import { extractSyncableMetadata, SYNCABLE_METADATA_KEYS } from '../../../shared/schemas/metadata'

export { extractSyncableMetadata, SYNCABLE_METADATA_KEYS }

export interface ReconcileMetadataResult {
  merged: AccountMetadata
  needsRemotePush: boolean
  hasLocalChanges: boolean
}

export function hasSyncableChanges(changes: Partial<AccountMetadata>): boolean {
  return SYNCABLE_METADATA_KEYS.some(key => changes[key] !== undefined)
}

export function reconcileAccountMetadata(
  local: AccountMetadata | undefined,
  remote: AccountMetadata | undefined,
): ReconcileMetadataResult {
  const syncableLocal = extractSyncableMetadata(local) as AccountMetadata
  const syncableRemote = extractSyncableMetadata(remote) as AccountMetadata

  const localHasSyncable = Object.keys(syncableLocal).length > 0
  const remoteHasSyncable = Object.keys(syncableRemote).length > 0

  if (!localHasSyncable && !remoteHasSyncable) {
    const merged: AccountMetadata = { ...(local || {}) }
    return {
      merged,
      needsRemotePush: false,
      hasLocalChanges: false,
    }
  }

  if (!remoteHasSyncable && localHasSyncable) {
    const updatedAt = syncableLocal.updatedAt || Date.now()
    const merged: AccountMetadata = {
      ...(local || {}),
      ...syncableLocal,
      updatedAt,
    }
    return {
      merged,
      needsRemotePush: true,
      hasLocalChanges: !deepEqual(local, merged),
    }
  }

  if (!localHasSyncable && remoteHasSyncable) {
    const merged: AccountMetadata = {
      ...(local || {}),
      ...syncableRemote,
    }
    return {
      merged,
      needsRemotePush: false,
      hasLocalChanges: true,
    }
  }

  // Both have syncable data
  const localTime = typeof syncableLocal.updatedAt === 'number' ? syncableLocal.updatedAt : 0
  const remoteTime = typeof syncableRemote.updatedAt === 'number' ? syncableRemote.updatedAt : 0
  const localIsNewerOrEqual = localTime >= remoteTime

  const merged: AccountMetadata = { ...(local || {}) }

  // 1. completedMigrations: set union
  if (syncableLocal.completedMigrations || syncableRemote.completedMigrations) {
    const migrations = Array.from(
      new Set([
        ...(syncableLocal.completedMigrations || []),
        ...(syncableRemote.completedMigrations || []),
      ]),
    )
    if (migrations.length > 0) {
      merged.completedMigrations = migrations
    }
  }

  // 2. defaultPrayerFrequency: field-level merge
  if (syncableLocal.defaultPrayerFrequency || syncableRemote.defaultPrayerFrequency) {
    const localFreq = syncableLocal.defaultPrayerFrequency || {}
    const remoteFreq = syncableRemote.defaultPrayerFrequency || {}
    merged.defaultPrayerFrequency = localIsNewerOrEqual
      ? { ...remoteFreq, ...localFreq }
      : { ...localFreq, ...remoteFreq }
  }

  // 3. prayerGoal: latest wins
  if (syncableLocal.prayerGoal !== undefined && syncableRemote.prayerGoal !== undefined) {
    merged.prayerGoal = localIsNewerOrEqual
      ? syncableLocal.prayerGoal
      : syncableRemote.prayerGoal
  } else if (syncableLocal.prayerGoal !== undefined) {
    merged.prayerGoal = syncableLocal.prayerGoal
  } else if (syncableRemote.prayerGoal !== undefined) {
    merged.prayerGoal = syncableRemote.prayerGoal
  }

  // 4. updatedAt
  merged.updatedAt = Math.max(localTime, remoteTime) || Date.now()

  const syncableMerged = extractSyncableMetadata(merged)
  const needsRemotePush = !deepEqual(syncableRemote, syncableMerged)
  const hasLocalChanges = !deepEqual(local, merged)

  return {
    merged,
    needsRemotePush,
    hasLocalChanges,
  }
}

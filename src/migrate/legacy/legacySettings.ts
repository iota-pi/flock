import type { AccountMetadata } from '../../state/metadata'
import { SYNCED_METADATA_KEYS } from '../../shared/schemas/metadata'
import type { LegacySettingsSource } from '@vault/client/worker'
import { createTrpcClient, type AppTrpcClient } from '../../api/trpcClient'

/** Settings the server stored in plaintext before the settings document, plus the timestamp used to merge them */
const LEGACY_SYNCABLE_METADATA_KEYS = [
  ...SYNCED_METADATA_KEYS,
  'updatedAt',
] as const satisfies readonly (keyof AccountMetadata)[]

type LegacySyncableMetadataKey = (typeof LEGACY_SYNCABLE_METADATA_KEYS)[number]
type LegacySyncableMetadata = Pick<AccountMetadata, LegacySyncableMetadataKey>

function extractLegacySyncableMetadata(
  metadata: Record<string, unknown> | undefined,
): LegacySyncableMetadata {
  if (!metadata || typeof metadata !== 'object') return {}
  const result: LegacySyncableMetadata = {}
  for (const key of LEGACY_SYNCABLE_METADATA_KEYS) {
    if (metadata[key] !== undefined) {
      result[key] = metadata[key] as never
    }
  }
  return result
}

/**
 * Merges the settings a device kept locally with the plaintext copy on the server, as Flock did
 * before the encrypted settings document. Returns only the synced settings.
 */
export function mergeLegacySettings(
  local: AccountMetadata | undefined,
  remote: AccountMetadata | undefined,
): AccountMetadata {
  const syncableLocal = extractLegacySyncableMetadata(local)
  const syncableRemote = extractLegacySyncableMetadata(remote)

  const localTime = typeof syncableLocal.updatedAt === 'number' ? syncableLocal.updatedAt : 0
  const remoteTime = typeof syncableRemote.updatedAt === 'number' ? syncableRemote.updatedAt : 0
  const localIsNewerOrEqual = localTime >= remoteTime
  const [older, newer] = localIsNewerOrEqual
    ? [syncableRemote, syncableLocal]
    : [syncableLocal, syncableRemote]

  const merged: AccountMetadata = {}

  // completedMigrations: set union
  const migrations = Array.from(
    new Set([
      ...(syncableLocal.completedMigrations || []),
      ...(syncableRemote.completedMigrations || []),
    ]),
  )
  if (migrations.length > 0) {
    merged.completedMigrations = migrations
  }

  // defaultPrayerFrequency: field-level merge, newer side wins per field
  if (older.defaultPrayerFrequency || newer.defaultPrayerFrequency) {
    merged.defaultPrayerFrequency = { ...older.defaultPrayerFrequency, ...newer.defaultPrayerFrequency }
  }

  // Scalars: newer side wins
  for (const key of ['prayerGoal', 'autoSnoozeWhenCompleted'] as const) {
    const value = newer[key] !== undefined ? newer[key] : older[key]
    if (value !== undefined) {
      merged[key] = value as never
    }
  }

  return merged
}

let client: AppTrpcClient | null = null

function getClient(): AppTrpcClient {
  client ??= createTrpcClient()
  return client
}

/**
 * Migrates the settings Flock used to store in plaintext on the account record (and mirror in each
 * device's local metadata) into the encrypted settings document. The server stopped storing new
 * plaintext settings, so only accounts last used before that still have them.
 */
export const flockLegacySettings: LegacySettingsSource = {
  async load(local, { accountId, withAuth }) {
    const response = await withAuth(() => getClient().migration.getLegacySettings.query({ account: accountId }))
    const remote = response.metadata as AccountMetadata
    const merged = mergeLegacySettings(local as AccountMetadata, remote)
    return Object.keys(merged).length > 0 ? merged : null
  },

  async clear({ accountId, withAuth }) {
    await withAuth(() => getClient().migration.clearLegacySettings.mutate({ account: accountId }))
  },

  obsoleteLocalKeys: ['updatedAt'],
}

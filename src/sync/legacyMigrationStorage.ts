export const LEGACY_MIGRATION_STORAGE_KEY_PREFIX = 'legacy-automerge-migrated'
export const LEGACY_METADATA_MIGRATION_STORAGE_KEY_PREFIX = 'metadata-automerge-migrated'

export function getLegacyMigrationStorageKey(accountId: string): string {
  return `${LEGACY_MIGRATION_STORAGE_KEY_PREFIX}_${accountId}`
}

export function getLegacyMetadataMigrationStorageKey(accountId: string): string {
  return `${LEGACY_METADATA_MIGRATION_STORAGE_KEY_PREFIX}_${accountId}`
}

import type { DataVersionPolicy } from '@vault/server'
import { FLOCK_DATA_VERSION } from '../shared/flockDataVersion'
import { SYNCED_METADATA_KEYS } from '../shared/schemas/metadata'
import type { FlockAccountFields } from './types'

export const flockDataVersionPolicy: DataVersionPolicy = {
  current: FLOCK_DATA_VERSION,
  async findBlockers({ account, accountData, vault }) {
    const blockers: string[] = []

    const legacyMetadata = (accountData as typeof accountData & FlockAccountFields).metadata ?? {}
    if (SYNCED_METADATA_KEYS.some(key => legacyMetadata[key] !== undefined)) {
      blockers.push('legacySettings')
    }

    // Level 2 moves the password to Argon2id. That's always done with a new password, which also
    // replaces a salt from before saltVersion 1.
    if (accountData.kdf?.algorithm !== 'argon2id') {
      blockers.push('legacyKeyDerivation')
    }

    // Deleted items are never decrypted, so their payloads don't matter
    const items = (await vault.listItemFormats({ account })).filter(item => !item.deleted)
    if (items.some(item => item.hasSnapshot && item.snapshotFormat === undefined)) {
      blockers.push('unboundSnapshots')
    }
    if (items.some(item => item.hasCipher && !item.hasSnapshot)) {
      blockers.push('legacyCipherItems')
    }

    // On accounts created before random data keys, key v1 is the master key derived from the
    // original password. `keyringVersion` follows the active key version, so above 1 the account
    // has rotated; until every live snapshot is re-encrypted, some data is still under v1.
    if (!accountData.randomDataKeys) {
      const v1Active = (accountData.keyringVersion ?? 1) <= 1
      if (v1Active || items.some(item => item.hasSnapshot && (item.snapshotKver ?? '1') === '1')) {
        blockers.push('passwordDerivedDataKey')
      }
    }

    return blockers
  },
}

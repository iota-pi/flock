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

    if (accountData.saltVersion !== 1 || accountData.iterations === undefined) {
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

    return blockers
  },
}

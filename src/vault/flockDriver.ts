import DynamoDriver, { type VaultTableNames } from '@vault/server/dynamo'
import { FLOCK_DATA_VERSION } from '../shared/flockDataVersion'
import type { FlockAccountFields } from './types'

export const FLOCK_TABLES: VaultTableNames = {
  accounts: process.env.ACCOUNTS_TABLE || 'FlockAccounts',
  items: process.env.ITEMS_TABLE || 'FlockItems',
  syncMessages: process.env.SYNC_MESSAGES_TABLE || 'FlockSyncMessages',
}

const FLOCK_ACCOUNT_DEFAULTS: FlockAccountFields & { dataVersion: number } = {
  // New accounts have nothing to migrate: they're created with Argon2id and a random data key
  dataVersion: FLOCK_DATA_VERSION,
  pushSubscriptions: [],
  reminderEnabled: false,
  reminderTime: '08:00',
  reminderTimezone: 'UTC',
}

export function createFlockDriver(devMode = false) {
  return new DynamoDriver({
    tables: FLOCK_TABLES,
    accountDefaults: FLOCK_ACCOUNT_DEFAULTS,
  }).connect(undefined, devMode)
}

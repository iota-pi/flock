import DynamoDriver, { type VaultTableNames } from '@vault/server/dynamo'
import type { FlockAccountFields } from './types'

export const FLOCK_TABLES: VaultTableNames = {
  accounts: process.env.ACCOUNTS_TABLE || 'FlockAccounts',
  items: process.env.ITEMS_TABLE || 'FlockItems',
  syncMessages: process.env.SYNC_MESSAGES_TABLE || 'FlockSyncMessages',
}

// New accounts' data version comes from `flockDataVersionPolicy.newAccountVersion`
const FLOCK_ACCOUNT_DEFAULTS: FlockAccountFields = {
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

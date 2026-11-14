import DynamoDriver, { resolveVaultTableNames, type AccountIndex } from '@vault/server/dynamo'
import { FLOCK_DATA_VERSION } from '../shared/flockDataVersion'
import type { FlockAccountFields } from './types'

export const FLOCK_TABLES = resolveVaultTableNames({}, {
  accounts: 'FlockAccounts',
  items: 'FlockItems',
  syncLog: 'FlockSyncLog',
  loginThrottle: 'FlockLoginThrottle',
})

const FLOCK_ACCOUNT_DEFAULTS: FlockAccountFields & { dataVersion: number } = {
  // New accounts have nothing to migrate: they're created with Argon2id and a random data key
  dataVersion: FLOCK_DATA_VERSION,
  pushSubscriptions: [],
  reminderEnabled: false,
  reminderTime: '08:00',
  reminderTimezone: 'UTC',
}

/**
 * The accounts with reminders on, which the notifier reads instead of scanning every account. Only
 * accounts that have `reminderIndex` are in it, and they all have the same value, so one query
 * returns them all with just what the notifier needs. sst.config.ts declares the same index.
 */
export const REMINDER_INDEX = {
  name: 'ReminderIndex',
  partitionKey: 'reminderIndex',
  attributes: ['pushSubscriptions', 'reminderTime', 'reminderTimezone', 'snoozeRemindersUntil'],
} as const satisfies AccountIndex

/** The `reminderIndex` of an account with reminders on. Accounts with them off have none. */
export const REMINDERS_ON = 'on'

export function createFlockDriver(devMode = false) {
  return new DynamoDriver({
    tables: FLOCK_TABLES,
    accountDefaults: FLOCK_ACCOUNT_DEFAULTS,
    accountIndexes: [{ ...REMINDER_INDEX, attributes: [...REMINDER_INDEX.attributes] }],
  }).connect(undefined, devMode)
}

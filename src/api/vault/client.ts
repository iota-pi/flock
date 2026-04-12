export {
  createAccount,
  getSecurityParams,
  getSession,
  recordPrayerCompletion,
} from './AccountClient'

export { fetchMany } from './ItemClient'

export {
  addPushSubscription,
  deletePushSubscription,
  getReminderSettings,
  updateReminderSettings,
} from './NotificationClient'

export type {
  AccountCreationResponse,
  CachedVaultItem,
  CreateAccountBody,
  FetchManyResponse,
  ItemId,
  LoginBody,
  ReminderSettingsResponse,
  VaultEnvelope,
  VaultItem,
} from './clientTypes'

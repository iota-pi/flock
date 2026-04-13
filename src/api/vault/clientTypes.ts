import type {
  ItemId,
  StandardItemEnvelope,
  TombstoneItemEnvelope,
} from '../../shared/itemTypes'
import type { LegacyItemEnvelope } from '../../sync/legacyTypes'

export type VaultEnvelope = LegacyItemEnvelope | StandardItemEnvelope | TombstoneItemEnvelope

export type CreateAccountBody = {
  salt: string
  authToken: string
}

export type AccountCreationResponse = {
  account: string
}

export type CachedVaultItem = VaultEnvelope & {
  ttl?: number
}

export type VaultItem = VaultEnvelope & {
  account?: string
  ttl?: number
  syncMessages?: Array<{
    cursor: number
    encryptedMessage: {
      iv: string
      cipher: string
    }
    createdAt?: number
  }>
}

export type ReminderSettingsResponse = {
  success: boolean
  reminderEnabled: boolean
  reminderTime: string
  reminderTimezone: string
}

export type { ItemId }
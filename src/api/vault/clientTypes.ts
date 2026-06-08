import type {
  StandardItemEnvelope,
  TombstoneItemEnvelope,
} from '../../shared/itemTypes'
import type { LegacyItemEnvelope } from '../../sync/shared/legacyTypes'

type VaultEnvelope = (
  LegacyItemEnvelope
  | StandardItemEnvelope
  | TombstoneItemEnvelope
)

export type CreateAccountBody = {
  salt: string
  authToken: string
  saltVersion?: number
}

export type AccountCreationResponse = {
  account: string
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

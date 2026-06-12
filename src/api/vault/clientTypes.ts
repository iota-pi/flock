import { z } from 'zod'
import {
  StandardItemEnvelopeSchema,
  TombstoneItemEnvelopeSchema,
} from '../../shared/schemas/items'
import { LegacyItemEnvelopeSchema } from '../../sync/shared/legacyTypes'
import {
  CreateAccountBodySchema,
  AccountCreationResponseSchema,
  ReminderSettingsResponseSchema,
} from '../../shared/schemas/trpc'

export const VaultEnvelopeSchema = z.union([
  LegacyItemEnvelopeSchema,
  StandardItemEnvelopeSchema,
  TombstoneItemEnvelopeSchema,
])

export type VaultEnvelope = z.infer<typeof VaultEnvelopeSchema>

export const CreateAccountBodySchemaClient = CreateAccountBodySchema.omit({ iterations: true })
export type CreateAccountBody = z.infer<typeof CreateAccountBodySchemaClient>

export type AccountCreationResponse = z.infer<typeof AccountCreationResponseSchema>

export const VaultItemSchema = VaultEnvelopeSchema.and(
  z.object({
    account: z.string().optional(),
    ttl: z.number().optional(),
    syncMessages: z.array(
      z.object({
        cursor: z.number(),
        encryptedMessage: z.object({
          iv: z.string(),
          cipher: z.string(),
        }),
        createdAt: z.number().optional(),
      })
    ).optional(),
  })
)

export type VaultItem = z.infer<typeof VaultItemSchema>

export type ReminderSettingsResponse = z.infer<typeof ReminderSettingsResponseSchema>


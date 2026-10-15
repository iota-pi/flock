import { z } from 'zod'
import {
  LegacyItemEnvelopeSchema,
  StandardItemEnvelopeSchema,
  TombstoneItemEnvelopeSchema,
} from '@vault/shared/envelopes'
import { CreateAccountBodySchema, AccountCreationResponseSchema } from '@vault/shared/api'

const VaultEnvelopeSchema = z.union([
  LegacyItemEnvelopeSchema,
  StandardItemEnvelopeSchema,
  TombstoneItemEnvelopeSchema,
])

export type CreateAccountBody = Omit<z.infer<typeof CreateAccountBodySchema>, 'iterations'>

export type AccountCreationResponse = z.infer<typeof AccountCreationResponseSchema>

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const VaultItemSchema = VaultEnvelopeSchema.and(
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


import { z } from 'zod'
import { CreateAccountBodySchema, AccountCreationResponseSchema } from '@vault/shared'

export type CreateAccountBody = z.infer<typeof CreateAccountBodySchema>

export type AccountCreationResponse = z.infer<typeof AccountCreationResponseSchema>

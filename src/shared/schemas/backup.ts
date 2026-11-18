import { z } from 'zod'
import { ItemIdSchema } from '@vault/shared'
import { accountMetadataSchema } from './metadata'

export const BackupPayloadV2Schema = z.object({
  version: z.literal(2),
  metadata: accountMetadataSchema.optional(),
  documents: z.record(ItemIdSchema, z.string().optional()),
})

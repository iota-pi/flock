import { z } from 'zod'
import { ItemIdSchema } from './items'
import { accountMetadataSchema } from './metadata'

export const BackupSyncStateSchema = z.object({
  cursors: z.array(z.tuple([ItemIdSchema, z.number()])),
  pendingSync: z.array(z.tuple([ItemIdSchema, z.array(z.string())])),
  lastModified: z.array(z.tuple([ItemIdSchema, z.number()])),
})

export const BackupPayloadV2Schema = z.object({
  version: z.literal(2),
  metadata: accountMetadataSchema.optional(),
  documents: z.record(ItemIdSchema, z.string().optional()),
}).merge(BackupSyncStateSchema.partial())

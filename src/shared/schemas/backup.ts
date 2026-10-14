import { z } from 'zod'
import { ItemIdSchema } from '../vault/ids'
import { accountMetadataSchema } from './metadata'
import { BackupSyncStateSchema } from '../../sync/shared/backupSyncState'

export const BackupPayloadV2Schema = z.object({
  version: z.literal(2),
  metadata: accountMetadataSchema.optional(),
  documents: z.record(ItemIdSchema, z.string().optional()),
}).merge(BackupSyncStateSchema.partial())

import { z } from 'zod'
import {
  BackupSyncStateSchema,
  BackupPayloadV2Schema,
} from 'src/shared/schemas/backup'

export type BackupSyncState = z.infer<typeof BackupSyncStateSchema>
export type BackupPayloadV2 = z.infer<typeof BackupPayloadV2Schema>


import { z } from 'zod'
import {
  BackupSyncStateSchema,
  BackupPayloadV2Schema,
  RestorePayloadSchema,
} from 'src/shared/schemas/backup'

export type BackupSyncState = z.infer<typeof BackupSyncStateSchema>
export type BackupPayloadV2 = z.infer<typeof BackupPayloadV2Schema>
export type RestorePayload = z.infer<typeof RestorePayloadSchema>


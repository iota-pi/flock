import { z } from 'zod'
import { BackupPayloadV2Schema } from 'src/shared/schemas/backup'

export type BackupPayloadV2 = z.infer<typeof BackupPayloadV2Schema>

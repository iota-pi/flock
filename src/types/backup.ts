import type { z } from 'zod'
import type { BackupPayloadV2Schema } from 'src/shared/schemas/backup'

export type BackupPayloadV2 = z.infer<typeof BackupPayloadV2Schema>

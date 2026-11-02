import { z } from 'zod'
import { ItemIdSchema } from '@vault/shared'

/** Sync bookkeeping included in backups so a restored device resumes where it left off */
export const BackupSyncStateSchema = z.object({
  cursors: z.array(z.tuple([ItemIdSchema, z.number()])),
  pendingSync: z.array(z.tuple([ItemIdSchema, z.array(z.string())])),
  lastModified: z.array(z.tuple([ItemIdSchema, z.number()])),
})

export type BackupSyncState = z.infer<typeof BackupSyncStateSchema>

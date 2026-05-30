import { z } from 'zod'
import { CryptoResultSchema } from './crypto'

export const VaultSnapshotSchema = z.object({
  itemId: z.string().min(1),
  snapshot: CryptoResultSchema,
  snapshotCursor: z.number().int().min(0),
  type: z.string().min(1),
  modified: z.number(),
  deleted: z.boolean().optional(),
})

export type VaultSnapshotInput = z.infer<typeof VaultSnapshotSchema>

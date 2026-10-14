import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { ItemIdSchema } from './ids'

export const VaultSnapshotSchema = z.object({
  itemId: ItemIdSchema,
  snapshot: CryptoResultSchema.optional(),
  snapshotCursor: z.number().int().min(0),
  type: z.string().min(1),
  modified: z.number(),
  deleted: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
}).superRefine((s, ctx) => {
  if (!s.snapshot && s.deleted !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['snapshot'],
      message: 'snapshot payload is required unless deleted',
    })
  }
})

export type VaultSnapshotInput = z.infer<typeof VaultSnapshotSchema>

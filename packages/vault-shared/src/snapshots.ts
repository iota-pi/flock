import { z } from 'zod'
import { CryptoResultSchema } from './crypto'
import { ItemIdSchema } from './ids'

export const VaultSnapshotSchema = z.object({
  itemId: ItemIdSchema,
  snapshot: CryptoResultSchema.optional(),
  snapshotCursor: z.number().int().min(0),
  modified: z.number(),
  deleted: z.boolean().optional(),
  version: z.number().int().min(0).optional(),
  /**
   * The Automerge heads of the saved document, encrypted and bound to the item. The manifest returns
   * them, so a device that already has those changes can skip fetching the snapshot.
   */
  heads: CryptoResultSchema.optional(),
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

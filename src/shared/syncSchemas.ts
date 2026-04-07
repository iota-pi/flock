import { z } from 'zod'
import {
  FetchItemsInputSchema,
  ItemFormInputSchema,
  UpdateMetadataBodySchema,
} from '../vault/trpc/schemas'

export {
  FetchItemsInputSchema,
  ItemFormInputSchema,
  UpdateMetadataBodySchema,
}

export const DlqFailureSnapshotSchema = z.object({
  timestamp: z.number(),
  queueLength: z.number().nonnegative(),
  attemptCount: z.number().nonnegative().optional(),
  queuedAt: z.number().optional(),
  payloadSummary: z.record(z.string(), z.unknown()).optional(),
})

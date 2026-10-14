import { z } from 'zod'
import { nanoid } from 'nanoid'

export const ItemIdSchema = z.string().min(1).trim().brand<'ItemId'>()

export type ItemId = z.infer<typeof ItemIdSchema>

/**
 * Generates a fresh 126-bit item ID. IDs must never be reused, because reusing one would merge
 * the old document's history into the new one (see docs/sync-design.md).
 */
export function generateItemId(): ItemId {
  return nanoid() as ItemId
}

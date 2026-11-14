import { z } from 'zod'
import { nanoid } from 'nanoid'
import { MAX_ITEM_ID_LENGTH } from './limits'

/** Every item ID ever generated (nanoid, UUID and `settings-<account>`) uses only these characters */
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export const ItemIdSchema = (
  z.string().trim().min(1).max(MAX_ITEM_ID_LENGTH).regex(ITEM_ID_PATTERN).brand<'ItemId'>()
)

export type ItemId = z.infer<typeof ItemIdSchema>

/**
 * Generates a fresh 126-bit item ID. IDs must never be reused, because reusing one would merge
 * the old document's history into the new one (see docs/sync-design.md).
 */
export function generateItemId(): ItemId {
  return nanoid() as ItemId
}

/**
 * The ID of an account's settings document. It is derived from the account so that every device
 * agrees on it without coordinating. Two devices can therefore create it concurrently, which is
 * safe because the settings document's top level is flat (see docs/sync-design.md).
 */
export function settingsDocId(accountId: string): ItemId {
  return `settings-${accountId}` as ItemId
}

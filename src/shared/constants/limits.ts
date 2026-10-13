/**
 * Maximum size in kilobytes for an item snapshot/document or sync message payload.
 */
export const MAX_ITEM_SIZE_KB = 350

/**
 * Maximum size in bytes for an item snapshot/document or sync message payload (350 KB).
 */
export const MAX_ITEM_SIZE_BYTES = MAX_ITEM_SIZE_KB * 1024

/**
 * Alias for MAX_ITEM_SIZE_BYTES.
 */
export const MAX_ITEM_SIZE = MAX_ITEM_SIZE_BYTES

/**
 * Maximum content size in kilobytes before recreation is rejected.
 */
export const MAX_ITEM_CONTENT_KB = 300

/**
 * Maximum content size in bytes before recreation is rejected (300 KB).
 */
export const MAX_ITEM_CONTENT_BYTES = MAX_ITEM_CONTENT_KB * 1024

export const ITEM_LIMITS = {
  NAME_MAX: 500,
  NAME_WARN: 400, // 80% of 500
  DESCRIPTION_MAX: 1000,
  DESCRIPTION_WARN: 800, // 80% of 1000
  NOTE_MAX: 5000,
  NOTE_WARN: 4000, // 80% of 5000
  MAX_ITEM_SIZE_KB,
  MAX_ITEM_SIZE_BYTES,
  MAX_ITEM_SIZE,
  MAX_ITEM_CONTENT_KB,
  MAX_ITEM_CONTENT_BYTES,
} as const

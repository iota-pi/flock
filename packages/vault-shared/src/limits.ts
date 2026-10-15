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

/**
 * Maximum size in bytes for a single incremental sync message. Encryption and base64 encoding
 * add roughly 37% overhead, so this keeps stored messages well under DynamoDB's 400 KB item limit.
 * Larger messages fall back to snapshot sync.
 */
export const MAX_INCREMENTAL_MESSAGE_BYTES = 256 * 1024

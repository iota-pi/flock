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

/**
 * The ciphertext a client asks `fetchSnapshotsByIds` to return at most, in characters. Lambda refuses
 * responses over 6 MB, and 50 items of up to 350 KB each (more as base64) can pass that, so this
 * leaves room for everything else in the response.
 */
export const MAX_FETCH_RESPONSE_CHARS = 4 * 1024 * 1024

/**
 * How many days a row stays in an account's sync log.
 */
export const SYNC_LOG_TTL_DAYS = 30

/**
 * Longest account ID the server accepts. The longest real ones are the first accounts' UUIDs, at
 * 36 characters.
 */
export const MAX_ACCOUNT_ID_LENGTH = 64

/**
 * Longest item ID the server accepts. Real IDs are nanoids (21 characters, 10 for notes), UUIDs from
 * before them (36) and `settings-<account>` (45 for a UUID account).
 */
export const MAX_ITEM_ID_LENGTH = 64

/**
 * Longest auth token, in characters. Current tokens are base64 SHA-512 hashes (88 characters). The
 * cap stops anyone storing junk in an account record, which every notifier scan would read again.
 */
export const MAX_AUTH_TOKEN_LENGTH = 256

/** Longest salt, in characters. Current salts are base64 of 16 bytes (24 characters). */
export const MAX_SALT_LENGTH = 256

/**
 * Longest encrypted keyring, in characters. Each key version adds about 70 characters, so this
 * leaves room for hundreds of rotations while keeping account records small.
 */
export const MAX_KEYRING_LENGTH = 64 * 1024

/** Longest IV, key version or other short field of a ciphertext envelope, in characters */
export const MAX_CIPHER_FIELD_LENGTH = 64

/**
 * Most devices an account remembers as having logged in before (see loginDevices.ts in
 * @vault/server). Registering another forgets the earliest.
 */
export const MAX_LOGIN_DEVICES = 10

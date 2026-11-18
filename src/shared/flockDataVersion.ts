/**
 * Flock's data version: the level of migrations its stored data should have had (see "Backwards
 * compatibility" in docs/vault-extraction.md).
 * - Version 1 is stage 2: encrypted settings, snapshots bound to their document, no pre-Automerge
 *   items and a current salt.
 * - Version 2 is Argon2id key derivation with no live data under a password-derived key (Part 1 of
 *   docs/local-encryption.md). It changes only the account's data, not the device's.
 * - Version 3 is local data sealed with a device storage key, with no plaintext stores left (Part 2
 *   of docs/local-encryption.md). It changes only the device's data, not the account's.
 * - Version 4 is per-item sync records and first start finished. Each item's server heads, base
 *   version and dirty flag are in the sync log database, with no whole-account `lastModified` or
 *   `syncedHeads` values left, and the device has moved onto the sync log, trusts no server heads
 *   from before it, holds no write-ahead log and has no item left waiting on first start (see
 *   "First start" in docs/sync-design.md). It changes only the device's data.
 */
export const FLOCK_DATA_VERSION = 4

/** The level at which a device's local data is sealed (see `SyncWorkerConfig.sealedDataVersion`) */
export const SEALED_DATA_VERSION = 3

/** The level at which first start has finished (see `SyncWorkerConfig.firstStartDataVersion`) */
export const FIRST_START_DATA_VERSION = 4

/**
 * The lowest device level the main app reads. Devices below it go through the migration app
 * (`src/migrate/`) first. At 4, a device whose local data is still in plaintext is sealed there, one
 * whose sync records are still whole-account values has them copied there, and one that hasn't
 * finished first start finishes it there, so the main app never runs it.
 */
export const MIN_DEVICE_DATA_VERSION = 4

/**
 * The lowest account level the main app reads. Accounts below it go through the migration app
 * (`src/migrate/`) first.
 */
export const MIN_ACCOUNT_DATA_VERSION = 2

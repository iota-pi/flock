/**
 * Flock's data version: the level of migrations its stored data should have had (see "Backwards
 * compatibility" in docs/vault-extraction.md).
 * - Version 1 is stage 2: encrypted settings, snapshots bound to their document, no pre-Automerge
 *   items and a current salt.
 * - Version 2 is Argon2id key derivation with no live data under a password-derived key (Part 1 of
 *   docs/local-encryption.md). It changes only the account's data, not the device's.
 * - Version 3 is local data sealed with a device storage key, with no plaintext stores left (Part 2
 *   of docs/local-encryption.md). It changes only the device's data, not the account's.
 */
export const FLOCK_DATA_VERSION = 3

/** The level at which a device's local data is sealed (see `SyncWorkerConfig.sealedDataVersion`) */
export const SEALED_DATA_VERSION = 3

/**
 * The lowest device level the main app reads. Devices below it go through the migration app
 * (`src/migrate/`) first.
 */
export const MIN_DEVICE_DATA_VERSION = 1

/**
 * The lowest account level the main app reads. Accounts below it go through the migration app
 * (`src/migrate/`) first.
 */
export const MIN_ACCOUNT_DATA_VERSION = 2

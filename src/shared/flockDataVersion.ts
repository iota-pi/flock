/**
 * Flock's data version: the level of migrations its stored data should have had (see "Backwards
 * compatibility" in docs/vault-extraction.md). Version 1 is stage 2: encrypted settings, snapshots
 * bound to their document, no pre-Automerge items and the current key derivation.
 */
export const FLOCK_DATA_VERSION = 1

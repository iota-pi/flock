import type { ItemId } from '@vault/shared'
import type { VaultDoc, VaultMetadata } from '../shared/types'
import type { CryptoResult } from '../keys/crypto'

/** A plain snapshot of an Automerge document, or a draft inside `handle.change` */
export type RawDoc = Record<string, unknown>

/**
 * Converts raw Automerge documents into the app's document shape. Runs inside the sync worker.
 */
export interface DocCodec {
  /**
   * Validates and normalizes a document snapshot whose `id` has already been filled in.
   * Must not throw: represent documents that fail validation in a form `isCorrupt` recognises.
   */
  decode(id: ItemId, raw: RawDoc): VaultDoc
  /** True for documents `decode` could not validate. Their content is never pushed over remote state. */
  isCorrupt(doc: VaultDoc): boolean
}

/** App-specific behaviour the engine calls out to */
export interface SyncDomainHooks {
  /**
   * When an oversized item is recreated under `newId`, returns the changes that repoint another
   * document's references from `oldId` to `newId`, or null if it has none.
   */
  remapReferences?(doc: VaultDoc, oldId: ItemId, newId: ItemId): Partial<VaultDoc> | null
  /** Adjusts the content copied into a recreated item, for example to reset its creation time */
  prepareRecreatedDoc?(doc: VaultDoc): VaultDoc
}

export interface LegacySettingsContext {
  accountId: string
  /** Runs a request with the session token set, refreshing the token once if it has expired */
  withAuth<T>(request: () => Promise<T>): Promise<T>
}

/**
 * Settings the app kept somewhere else before the settings document existed. After each manifest
 * sync, the engine copies them into the settings document and then calls `clear`.
 */
export interface LegacySettingsSource {
  /**
   * Returns the settings to migrate, or null when there are none. `local` is this device's local
   * metadata, which still holds synced keys until they are migrated. Keys the settings document
   * already has are kept.
   */
  load(local: VaultMetadata, context: LegacySettingsContext): Promise<VaultMetadata | null>
  /** Removes the legacy copy once its settings are in the settings document */
  clear(context: LegacySettingsContext): Promise<void>
  /** Local metadata keys only the legacy mechanism used. They are removed along with the synced keys. */
  obsoleteLocalKeys?: readonly string[]
}

/**
 * An item row as the server returned it. Rows in formats the library no longer reads carry fields
 * it doesn't describe, so they are left loose.
 */
export interface LegacyItemEnvelope {
  item: ItemId
  metadata?: Record<string, unknown>
  [field: string]: unknown
}

export interface LegacyItemContext {
  /** Makes sure the key with this version is loaded, waiting briefly for it. Returns whether it is. */
  ensureKey(kver: string): Promise<boolean>
  /** Decrypts a ciphertext that isn't bound to a document, with the key version it names */
  decrypt(payload: CryptoResult): Promise<Uint8Array>
}

export interface SyncDomain {
  codec: DocCodec
  hooks: SyncDomainHooks
  /**
   * Metadata keys stored in the account's encrypted settings document, which syncs like any other
   * document. Other keys stay local to the device. Keep the values flat where possible: two devices
   * that first set the same nested object concurrently keep only one of them.
   */
  syncedMetadataKeys?: readonly string[]
  /**
   * Keys of string fields, at any depth of an item, that merge concurrent edits character by character.
   * Suits long free text, where keeping both edits matters more than a clean result. Every other string
   * is replaced whole and one concurrent edit wins, which is what names, enums and IDs need.
   */
  mergedTextFields?: readonly string[]
  /**
   * The app's current data version: the level of migrations its stored data should have had. The
   * worker records it for the device and asks the server to raise the account to it (see
   * DataVersionTracker). Leave it unset (0) until the app has had a migration.
   */
  dataVersion?: number
}

/**
 * Everything the engine runs only to bring data from older formats and layouts up to date. An app
 * passes these only in its migration app (see "Backwards compatibility" in docs/vault-extraction.md),
 * so its main app builds none of it. Each belongs to a migration level and goes when that level is
 * retired. The migration app is rebuilt against the current library, so these signatures must stay
 * stable while their level is live.
 */
export interface LegacyHooks {
  /**
   * Decodes an item stored in a format the library no longer reads. Called only for rows that have
   * no snapshot. Returns the document's content, or null if the row isn't in a format the app knows.
   * The engine stores the result as a new document and uploads it as a snapshot. Without it, such a
   * row is reported as `migration_required`. Level 1.
   */
  decodeLegacyItem?(item: LegacyItemEnvelope, context: LegacyItemContext): Promise<RawDoc | null>
  /**
   * Where the app kept synced settings before the settings document existed. With it, each manifest
   * sync moves them, and any synced keys left in local metadata, into the settings document. Level 1.
   */
  legacySettings?: LegacySettingsSource
  /**
   * Brings the account's local data from older layouts into the current one. Runs once per
   * session before any store is read, one tab at a time. Stores only read the current layout.
   */
  migrateLocalData?: (accountId: string) => Promise<void>
  /**
   * Rewrites every snapshot once per device, so snapshots from before ciphertexts were bound to
   * their document are replaced (see SnapshotFormatUpgrade). Level 1.
   */
  upgradeSnapshotFormat?: boolean
  /**
   * Fetches the manifest on every sync, rather than at most every `manifestSyncMinGap` on a device
   * that has items, so every row on the server is seen and none in a legacy format is missed
   */
  fetchManifestEverySync?: boolean
  /**
   * The app's data version (`SyncDomain.dataVersion`) at which a device that synced before the log
   * has reset its sync state for it (see `resetSyncState`). Below `minDataVersion` the session runs
   * the reset at start, and the device's recorded level stays below this one until it has run and
   * the old write-ahead log is gone. Once `minDataVersion` is at or above it, every device that
   * starts has reset (or had nothing to reset), so the session doesn't. Level 4.
   */
  syncResetDataVersion?: number
}

export const passthroughCodec: DocCodec = {
  decode: (_id, raw) => raw as VaultDoc,
  isCorrupt: () => false,
}

export const DEFAULT_SYNC_DOMAIN: SyncDomain = {
  codec: passthroughCodec,
  hooks: {},
}

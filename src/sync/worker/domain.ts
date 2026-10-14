import type { ItemId } from 'src/shared/vault/ids'
import type { VaultDoc, VaultMetadata } from '../shared/types'

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
  /**
   * Plaintext kind stored alongside each snapshot on the server.
   * Stage 2 of docs/vault-extraction.md removes it.
   */
  snapshotKind(doc: VaultDoc): string
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

export interface ReconcileMetadataResult {
  merged: VaultMetadata
  needsRemotePush: boolean
  hasLocalChanges: boolean
}

/**
 * Syncs selected account metadata fields through the server's plaintext account record.
 * Stage 2 of docs/vault-extraction.md replaces this with an encrypted settings document.
 */
export interface MetadataSyncAdapter {
  hasSyncableChanges(changes: Partial<VaultMetadata>): boolean
  extractSyncable(metadata: VaultMetadata | undefined): VaultMetadata
  reconcile(local: VaultMetadata | undefined, remote: VaultMetadata | undefined): ReconcileMetadataResult
}

export interface SyncDomain {
  codec: DocCodec
  hooks: SyncDomainHooks
  /** Without an adapter, account metadata stays local to the device */
  metadataSync?: MetadataSyncAdapter
}

export const passthroughCodec: DocCodec = {
  decode: (_id, raw) => raw as VaultDoc,
  isCorrupt: () => false,
  snapshotKind: () => 'doc',
}

export const DEFAULT_SYNC_DOMAIN: SyncDomain = {
  codec: passthroughCodec,
  hooks: {},
}

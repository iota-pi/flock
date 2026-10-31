import * as Automerge from '@automerge/automerge/slim'
import type { AutomergeUrl, DocHandle, Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '@vault/shared'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { KeyProvider } from '../../api/Keyring'
import type { DocCodec } from './domain'
import { ItemId } from '@vault/shared'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const log = createLogger('SnapshotBuilder')

export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  | { type: 'error'; reason?: string }

export interface PreparedSnapshotItem {
  snapshot: VaultSnapshotInput
  tick: number
  heads?: string[]
}

/**
 * Direct ciphertext length estimation.
 * Estimates the serialized JSON size by calculating ciphertext length plus base metadata/envelope overhead (~128 bytes),
 * avoiding costly `JSON.stringify(snapshot)` string allocations.
 */
export function estimateSnapshotSize(snapshot: VaultSnapshotInput): number {
  const BASE_OVERHEAD_BYTES = 128
  const cipherBytes = snapshot.snapshot?.cipher?.length ?? 0
  const ivBytes = snapshot.snapshot?.iv?.length ?? 0
  const idBytes = snapshot.itemId?.length ?? 0
  return cipherBytes + ivBytes + idBytes + BASE_OVERHEAD_BYTES
}

export interface BuildSnapshotOptions {
  signal?: AbortSignal
  codec: DocCodec
}

/**
 * How long a snapshot build waits for the document, matching the doc store's whole lookup budget for a
 * document it knows is stored (fast path plus extended attempt)
 */
export const SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS = SYNC_TIMEOUTS.docStoreFastPath + SYNC_TIMEOUTS.docStoreExtended

type DocLookupResult =
  | { type: 'found'; handle: DocHandle<unknown> | undefined }
  | { type: 'timeout' }

/**
 * Looks the document up, giving up after SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS. `repo.find` can stay pending
 * forever: for a document whose local records fail to decrypt, and for one missing from storage, which no
 * peer answers for. An abort of the caller's signal is rethrown so the push stops rather than counting it
 * as this item's failure.
 */
async function findWithTimeout(
  repo: Repo,
  documentUrl: AutomergeUrl,
  signal: AbortSignal | undefined,
): Promise<DocLookupResult> {
  signal?.throwIfAborted()
  const timeout = new AbortController()
  const timeoutId = setTimeout(() => timeout.abort(), SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS)
  const lookupSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  try {
    return { type: 'found', handle: await repo.find(documentUrl, { signal: lookupSignal }) }
  } catch {
    signal?.throwIfAborted()
    if (timeout.signal.aborted) {
      return { type: 'timeout' }
    }
    return { type: 'found', handle: undefined }
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function buildSnapshot(
  repo: Repo,
  itemId: ItemId,
  snapshotCursor: number,
  keys: KeyProvider,
  options: BuildSnapshotOptions,
): Promise<BuildSnapshotResult> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const lookup = await findWithTimeout(repo, documentUrl, options.signal)
  if (lookup.type === 'timeout') {
    return {
      type: 'error',
      reason: `Document lookup timed out after ${SNAPSHOT_DOC_LOOKUP_TIMEOUT_MS}ms`,
    }
  }
  const handle = lookup.handle
  if (!handle) {
    return { type: 'error', reason: 'Document handle not found' }
  }

  if (!handle.isReady()) {
    return { type: 'not-ready' }
  }

  const doc = handle.doc()
  if (!doc) {
    return { type: 'error', reason: 'Document data not available' }
  }

  const snapshotTimestamp = Date.now()
  const heads = Automerge.getHeads(doc)
  const binary = Automerge.save(doc)
  if (!binary || binary.byteLength === 0) {
    return { type: 'error', reason: 'Failed to serialize document binary' }
  }

  let encryptedDoc
  try {
    encryptedDoc = await keys.encryptBytes(binary, itemId)
  } catch (error) {
    if (classifySyncError(error).isTransientVault) {
      return { type: 'not-ready' }
    }
    throw error
  }

  const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>, options.codec)
  if (!itemSnapshot) {
    return { type: 'error', reason: 'Failed to normalize item snapshot' }
  }

  return {
    type: 'success',
    snapshot: {
      itemId,
      snapshot: encryptedDoc,
      snapshotCursor,
      modified: snapshotTimestamp,
      deleted: !!itemSnapshot.deleted || undefined,
    },
    heads,
  }
}

/**
 * Strips the payload from a deleted snapshot, leaving only the metadata needed
 * for the server to record the tombstone. Used when the full document history
 * is too large to upload.
 */
export function toTombstoneSnapshot(snapshot: VaultSnapshotInput): VaultSnapshotInput {
  if (snapshot.deleted !== true) {
    throw new Error(`Cannot create a tombstone for non-deleted item ${snapshot.itemId}`)
  }
  return {
    itemId: snapshot.itemId,
    snapshotCursor: snapshot.snapshotCursor,
    modified: snapshot.modified,
    deleted: true,
  }
}

export class SnapshotBuilder {
  constructor(
    private readonly repo: Repo,
    private readonly keys: KeyProvider,
    private readonly codec: DocCodec,
  ) {}

  async build(
    itemId: ItemId,
    snapshotCursor: number,
    options?: Omit<BuildSnapshotOptions, 'codec'>,
  ): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.repo, itemId, snapshotCursor, this.keys, { ...options, codec: this.codec })
    } catch (error: unknown) {
      // The caller stopped; that says nothing about this item
      if (options?.signal?.aborted) {
        throw error
      }
      const classified = classifySyncError(error)
      if (classified.isTransientVault) {
        log.warn('Vault is locked or uninitialized during snapshot build, waiting', error)
        return { type: 'not-ready' }
      }
      log.error('failed to encrypt snapshot binary', error)
      return {
        type: 'error',
        reason: error instanceof Error ? error.message : 'Failed to encrypt snapshot binary',
      }
    }
  }

  estimateSize(snapshot: VaultSnapshotInput): number {
    return estimateSnapshotSize(snapshot)
  }
}


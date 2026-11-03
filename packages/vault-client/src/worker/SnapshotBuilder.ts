import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { ItemId, VaultSnapshotInput } from '@vault/shared'
import { findWithTimeout, normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { KeyProvider } from '../keys/Keyring'
import type { DocCodec } from './domain'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { encryptSnapshotHeads } from './snapshotHeads'

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
  const headsBytes = (snapshot.heads?.cipher.length ?? 0) + (snapshot.heads?.iv.length ?? 0)
  return cipherBytes + ivBytes + idBytes + headsBytes + BASE_OVERHEAD_BYTES
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

/** Builds an item's encrypted snapshot from its local Automerge doc */
export class SnapshotBuilder {
  constructor(
    private readonly repo: Repo,
    private readonly keys: KeyProvider,
    private readonly codec: DocCodec,
  ) {}

  /** Reports failures as results; only an abort of `signal` throws */
  async build(itemId: ItemId, snapshotCursor: number, options?: { signal?: AbortSignal }): Promise<BuildSnapshotResult> {
    try {
      return await this.buildOrThrow(itemId, snapshotCursor, options?.signal)
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
      log.error('Failed to build snapshot', error)
      return {
        type: 'error',
        reason: error instanceof Error ? error.message : 'Failed to build snapshot',
      }
    }
  }

  private async buildOrThrow(itemId: ItemId, snapshotCursor: number, signal?: AbortSignal): Promise<BuildSnapshotResult> {
    const documentUrl = toAutomergeUrlFromItemId(itemId)
    const lookup = await findWithTimeout(this.repo, documentUrl, SYNC_TIMEOUTS.snapshotDocLookup, signal)
    if (lookup.type === 'timeout') {
      return {
        type: 'error',
        reason: `Document lookup timed out after ${SYNC_TIMEOUTS.snapshotDocLookup}ms`,
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

    const encryptedDoc = await this.keys.encryptBytes(binary, itemId)
    const encryptedHeads = heads.length > 0 ? await encryptSnapshotHeads(this.keys, itemId, heads) : undefined

    const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>, this.codec)
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
        ...(encryptedHeads ? { heads: encryptedHeads } : {}),
      },
      heads,
    }
  }
}

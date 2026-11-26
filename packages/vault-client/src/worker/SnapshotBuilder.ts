import * as Automerge from '@automerge/automerge/slim'

import type { ItemId, VaultSnapshotInput } from '@vault/shared'
import { normalizeItemSnapshot, type AutomergeDocStore } from './docStore'
import type { KeyProvider } from '../keys/Keyring'
import type { DocCodec } from './domain'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'
import { checkAlive, untilAborted } from '../utils/abort'
import { encryptSnapshotHeads } from './snapshotHeads'
import type { ItemSyncState } from './ItemSyncState'

const log = createLogger('SnapshotBuilder')

export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  /** The item can't have a snapshot yet: its changes must reach the log first */
  | { type: 'deferred'; reason: 'unpushed' }
  | { type: 'error'; reason?: string }

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
 * for the server to record the tombstone.
 */
export function toTombstoneSnapshot(snapshot: VaultSnapshotInput): VaultSnapshotInput {
  if (snapshot.deleted !== true) {
    throw new Error(`Cannot create a tombstone for non-deleted item ${snapshot.itemId}`)
  }
  return { itemId: snapshot.itemId, deleted: true }
}

/**
 * Builds an item's snapshot, and if it holds changes the log doesn't have yet (S1), pushes them and
 * builds once more. Changes made since the poll's push land here.
 */
export async function buildAfterPush(
  builder: Pick<SnapshotBuilder, 'build'>,
  pushToLog: (itemIds: ItemId[], signal: AbortSignal) => Promise<unknown>,
  itemId: ItemId,
  signal: AbortSignal,
): Promise<BuildSnapshotResult> {
  const result = await builder.build(itemId, { signal })
  if (result.type !== 'deferred' || result.reason !== 'unpushed') return result
  await pushToLog([itemId], signal)
  return builder.build(itemId, { signal })
}

/** Builds an item's encrypted snapshot from its local Automerge doc */
export class SnapshotBuilder {
  constructor(
    /** Its lookup bounds the wait, and gives up at once on a doc whose local records can't be read */
    private readonly docStore: Pick<AutomergeDocStore, 'findHandle'>,
    private readonly keys: KeyProvider,
    private readonly codec: DocCodec,
    /** Snapshot coverage (S1), so a snapshot only holds what the log has, and the server's version */
    private readonly syncState: Pick<ItemSyncState, 'isCovered' | 'getBaseVersion'>,
  ) {}

  /** Reports failures as results; only an abort of `signal` throws */
  async build(itemId: ItemId, options?: { signal?: AbortSignal }): Promise<BuildSnapshotResult> {
    try {
      return await this.buildOrThrow(itemId, options?.signal)
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

  private async buildOrThrow(itemId: ItemId, signal?: AbortSignal): Promise<BuildSnapshotResult> {
    checkAlive(signal)
    const lookup = this.docStore.findHandle(itemId)
    const handle = signal ? await untilAborted(lookup, signal) : await lookup
    if (!handle) {
      return { type: 'error', reason: 'Document handle not found' }
    }

    const doc = handle.doc()
    if (!doc) {
      return { type: 'error', reason: 'Document data not available' }
    }

    const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>, this.codec)
    if (!itemSnapshot) {
      return { type: 'error', reason: 'Failed to normalize item snapshot' }
    }

    // The server keeps nothing of a deleted item's content and nothing reads it, so once the server
    // has the item a payload-less tombstone is enough, with no history to save or coverage to wait
    // for. An item it has never seen still gets its whole snapshot, since a tombstone for an unseen ID
    // writes no row, and a device holding the item's later log rows without its create needs the row
    // to learn it's deleted.
    if (itemSnapshot.deleted && this.syncState.getBaseVersion(itemId) > 0) {
      return { type: 'success', snapshot: { itemId, deleted: true } }
    }

    // In the same synchronous section as the save, so the snapshot holds exactly what was checked
    if (!this.syncState.isCovered(itemId, doc)) {
      return { type: 'deferred', reason: 'unpushed' }
    }

    const heads = Automerge.getHeads(doc)
    const binary = Automerge.save(doc)
    if (!binary || binary.byteLength === 0) {
      return { type: 'error', reason: 'Failed to serialize document binary' }
    }

    const encryptedDoc = await this.keys.encryptBytes(binary, itemId)
    const encryptedHeads = heads.length > 0 ? await encryptSnapshotHeads(this.keys, itemId, heads) : undefined

    return {
      type: 'success',
      snapshot: {
        itemId,
        snapshot: encryptedDoc,
        deleted: !!itemSnapshot.deleted || undefined,
        ...(encryptedHeads ? { heads: encryptedHeads } : {}),
      },
      heads,
    }
  }
}

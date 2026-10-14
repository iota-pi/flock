import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { encryptBytes } from '../../api/vault'
import { normalizeSnapshotType } from './utils/snapshot'
import { ItemId } from 'src/shared/schemas/items'
import { classifySyncError } from './utils/errorClassifier'
import { estimateSnapshotSize } from './SnapshotBatchAccumulator'

export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  | { type: 'error'; reason?: string }

export interface BuildSnapshotOptions {
  signal?: AbortSignal
}

export async function buildSnapshot(
  repo: Repo,
  itemId: ItemId,
  snapshotCursor: number,
  options?: BuildSnapshotOptions,
): Promise<BuildSnapshotResult> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const handle = await repo.find(documentUrl, options).catch(() => undefined)
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
    encryptedDoc = await encryptBytes(binary)
  } catch (error) {
    if (classifySyncError(error).isTransientVault) {
      return { type: 'not-ready' }
    }
    throw error
  }

  const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>)
  if (!itemSnapshot) {
    return { type: 'error', reason: 'Failed to normalize item snapshot' }
  }

  const originalType = (
    itemSnapshot.type === 'error'
      ? itemSnapshot.originalType
      : itemSnapshot.type
  )
  return {
    type: 'success',
    snapshot: {
      itemId,
      snapshot: encryptedDoc,
      snapshotCursor,
      type: normalizeSnapshotType(itemSnapshot.type, originalType),
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
    type: snapshot.type,
    modified: snapshot.modified,
    deleted: true,
  }
}

export class SnapshotBuilder {
  constructor(private readonly repo: Repo) {}

  async build(
    itemId: ItemId,
    snapshotCursor: number,
    options?: BuildSnapshotOptions,
  ): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.repo, itemId, snapshotCursor, options)
    } catch (error: unknown) {
      const classified = classifySyncError(error)
      if (classified.isTransientVault) {
        console.warn('[SnapshotBuilder] Vault is locked or uninitialized during snapshot build, waiting', error)
        return { type: 'not-ready' }
      }
      console.error('[SnapshotBuilder] failed to encrypt snapshot binary', error)
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


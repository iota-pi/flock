import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '@vault/shared'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { KeyProvider } from '../../api/Keyring'
import { passthroughCodec, type DocCodec } from './domain'
import { ItemId } from '@vault/shared'
import { classifySyncError } from './utils/errorClassifier'
import { estimateSnapshotSize } from './SnapshotBatchAccumulator'
import { createLogger } from '../utils/logger'

const log = createLogger('SnapshotBuilder')

export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  | { type: 'error'; reason?: string }

export interface BuildSnapshotOptions {
  signal?: AbortSignal
  codec?: DocCodec
}

export async function buildSnapshot(
  repo: Repo,
  itemId: ItemId,
  snapshotCursor: number,
  keys: KeyProvider,
  options?: BuildSnapshotOptions,
): Promise<BuildSnapshotResult> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const handle = await repo.find(documentUrl, options?.signal ? { signal: options.signal } : undefined).catch(() => undefined)
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

  const codec = options?.codec ?? passthroughCodec
  const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>, codec)
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
    private readonly codec: DocCodec = passthroughCodec,
  ) {}

  async build(
    itemId: ItemId,
    snapshotCursor: number,
    options?: BuildSnapshotOptions,
  ): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.repo, itemId, snapshotCursor, this.keys, { codec: this.codec, ...options })
    } catch (error: unknown) {
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


import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { encryptBytes } from '../../api/vault'
import { normalizeSnapshotType } from './utils/snapshot'
import { ItemId } from 'src/shared/schemas/items'
import {
  isTransientVaultError,
  TRANSIENT_VAULT_ERROR_SUBSTRINGS,
} from './utils/vaultErrors'

export { isTransientVaultError, TRANSIENT_VAULT_ERROR_SUBSTRINGS }

export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  | { type: 'error'; reason?: string }

export async function buildSnapshot(
  repo: Repo,
  itemId: ItemId,
  snapshotCursor: number,
): Promise<BuildSnapshotResult> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const handle = await repo.find(documentUrl).catch(() => undefined)
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
    if (isTransientVaultError(error)) {
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

import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { encryptBytes, VaultNotInitializedError } from '../../api/vault'
import { normalizeSnapshotType } from './utils/snapshot'
import { ItemId } from 'src/shared/schemas/items'


export type BuildSnapshotResult =
  | { type: 'success'; snapshot: VaultSnapshotInput; heads?: string[] }
  | { type: 'not-ready' }
  | { type: 'error'; reason?: string }

export const TRANSIENT_VAULT_ERROR_SUBSTRINGS = [
  'vault is locked',
  'vaultnotinitializederror',
  'not initialized',
  'active key not found',
] as const

export function isTransientVaultError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof VaultNotInitializedError) return true
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  const name = error instanceof Error ? error.name : ''
  return (
    name === 'VaultNotInitializedError' ||
    TRANSIENT_VAULT_ERROR_SUBSTRINGS.some((substring) => message.includes(substring))
  )
}

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
      modified: Date.now(),
      deleted: !!itemSnapshot.deleted || undefined,
    },
    heads,
  }
}

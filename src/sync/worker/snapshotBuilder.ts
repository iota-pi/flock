import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { normalizeItemSnapshot } from './docStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { encryptBytes } from '../../api/vault'
import { normalizeSnapshotType } from './utils/snapshot'
import { ItemId } from 'src/shared/schemas/items'


export async function buildSnapshot(
  repo: Repo,
  itemId: ItemId,
  snapshotCursor: number,
): Promise<VaultSnapshotInput | null> {
  const documentUrl = toAutomergeUrlFromItemId(itemId)
  const handle = await repo.find(documentUrl).catch(() => undefined)
  if (!handle) {
    return null
  }

  if (!handle.isReady()) {
    return null
  }

  const doc = handle.doc()
  if (!doc) {
    return null
  }

  const binary = Automerge.save(doc)
  if (!binary || binary.byteLength === 0) {
    return null
  }

  const encryptedDoc = await encryptBytes(binary)

  const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>)
  if (!itemSnapshot) {
    return null
  }

  const originalType = (
    itemSnapshot.type === 'error'
      ? itemSnapshot.originalType
      : itemSnapshot.type
  )
  return {
    itemId,
    snapshot: encryptedDoc,
    snapshotCursor,
    type: normalizeSnapshotType(itemSnapshot.type, originalType),
    modified: Date.now(),
    deleted: !!itemSnapshot.deleted || undefined,
  }
}

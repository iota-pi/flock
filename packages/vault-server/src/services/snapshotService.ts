import type { z } from 'zod'
import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { PutSnapshotBatchSchema, ItemId } from '@vault/shared'
import { QuotaExceededError } from '../errors'

export type PutSnapshotInput = z.infer<typeof PutSnapshotBatchSchema>

export interface PersistSnapshotsResult {
  success: boolean
  persisted: number
  total: number
  results: Array<{ itemId: ItemId; version: number }>
}

/** The account's storage as it was when the request came in */
export interface StorageAllowance {
  /** The account's `storageBytes` */
  usedBytes: number
  quotaBytes: number
}

/**
 * Persists a batch of encrypted item snapshots, each written on its own. Logs any write that fails
 * and reports which ones were persisted.
 *
 * An account at its storage quota can still delete items. Its tombstones are written without their
 * payloads, which the driver would drop anyway, and so only mark items it already has deleted (it
 * doesn't create rows for payload-less tombstones). A batch that still carries a live snapshot is
 * turned away whole with `QuotaExceededError`. Rejecting single items instead would get them
 * quarantined, though nothing is wrong with them.
 */
export async function persistSnapshots(
  vault: VaultDriver,
  input: PutSnapshotInput,
  storage: StorageAllowance,
): Promise<PersistSnapshotsResult> {
  const atQuota = storage.usedBytes >= storage.quotaBytes
  if (atQuota && input.snapshots.some(snapshot => snapshot.snapshot && !snapshot.deleted)) {
    throw new QuotaExceededError(`Account has used ${storage.usedBytes} of its ${storage.quotaBytes} bytes of storage`)
  }
  // Older clients send tombstones with their full payload. Exempting those from the quota as they
  // are would let them create rows for IDs the server has never seen, so they lose the payload.
  const snapshots: PutSnapshotInput['snapshots'] = atQuota
    ? input.snapshots.map(snapshot => (snapshot.deleted ? withoutPayload(snapshot) : snapshot))
    : input.snapshots

  const results = await Promise.allSettled(
    snapshots.map(async snapshot => {
      const item: VaultItem = {
        account: input.account,
        item: snapshot.itemId,
        // The client's `modified` isn't stored: the driver records the server's own `modifiedAt`
        metadata: {
          iv: '',
          ...(snapshot.deleted ? { deleted: true } : {}),
        },
        // The driver drops a tombstone's content, whether sent or stored. It writes payload-less
        // tombstones only to items it has, answering version 0 for any other.
        ...(snapshot.snapshot ? { snapshot: snapshot.snapshot } : {}),
        // Without heads, the driver removes any stored ones, which belonged to an older snapshot
        ...(snapshot.snapshot && snapshot.heads ? { heads: snapshot.heads } : {}),
      }

      const setResult = await vault.set(item)
      return {
        itemId: snapshot.itemId,
        version: setResult.version,
        storageDelta: setResult.storageDelta,
      }
    })
  )

  const persistedResults = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return [result.value]
    }
    console.error(
      `[snapshotService.persistSnapshots] Failed to persist snapshot for item ${snapshots[index].itemId}:`,
      result.reason,
    )
    return []
  })
  const storageDelta = persistedResults.reduce((sum, result) => sum + result.storageDelta, 0)
  if (storageDelta !== 0) {
    // Not in the same transaction as the writes: if this fails, usage drifts low until a recount
    await vault.addStorageUsage({ account: input.account, bytes: storageDelta })
  }
  const persisted = persistedResults.length

  return {
    success: persisted === input.snapshots.length,
    persisted,
    total: input.snapshots.length,
    results: persistedResults.map(({ itemId, version }) => ({ itemId, version })),
  }
}

function withoutPayload<T extends { snapshot?: unknown; heads?: unknown }>(
  { snapshot: _snapshot, heads: _heads, ...rest }: T,
): Omit<T, 'snapshot' | 'heads'> {
  return rest
}

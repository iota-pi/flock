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
  /** The log's head, read after the writes */
  logSeq: number
}

/** The account's storage as it was when the request came in */
export interface StorageAllowance {
  /** The account's `storageBytes` */
  usedBytes: number
  quotaBytes: number
}

/**
 * Persists a batch of encrypted item snapshots, each written on its own. Logs any write that fails
 * and reports which ones were persisted, with the log's head once the writes are done.
 *
 * An account at its storage quota can still delete items, but a batch that carries any snapshot is
 * turned away whole with `QuotaExceededError`. Rejecting single items instead would get them
 * quarantined, though nothing is wrong with them.
 */
export async function persistSnapshots(
  vault: VaultDriver,
  input: PutSnapshotInput,
  storage: StorageAllowance,
): Promise<PersistSnapshotsResult> {
  if (storage.usedBytes >= storage.quotaBytes && input.snapshots.some(snapshot => snapshot.snapshot)) {
    throw new QuotaExceededError(`Account has used ${storage.usedBytes} of its ${storage.quotaBytes} bytes of storage`)
  }

  const results = await Promise.allSettled(
    input.snapshots.map(async snapshot => {
      const item: VaultItem = {
        account: input.account,
        item: snapshot.itemId,
        // The client's `modified` isn't stored: the driver records the server's own `modifiedAt`
        metadata: {
          iv: '',
          ...(snapshot.deleted ? { deleted: true } : {}),
        },
        // Payload-less tombstones intentionally omit the snapshot so the previous one is kept
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
      `[snapshotService.persistSnapshots] Failed to persist snapshot for item ${input.snapshots[index].itemId}:`,
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
  const logSeq = await vault.readLogHead({ account: input.account })

  return {
    success: persisted === input.snapshots.length,
    persisted,
    total: input.snapshots.length,
    results: persistedResults.map(({ itemId, version }) => ({ itemId, version })),
    logSeq,
  }
}

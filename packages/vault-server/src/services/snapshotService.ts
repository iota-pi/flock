import type { z } from 'zod'
import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { PutSnapshotBatchSchema, ItemId } from '@vault/shared'

export type PutSnapshotInput = z.infer<typeof PutSnapshotBatchSchema>

export interface PersistSnapshotsResult {
  success: boolean
  persisted: number
  total: number
  results: Array<{ itemId: ItemId; version: number }>
  /** The log's head, read after the writes */
  logSeq: number
}

/**
 * Persists a batch of encrypted item snapshots, each written on its own. Logs any write that fails
 * and reports which ones were persisted, with the log's head once the writes are done.
 */
export async function persistSnapshots(
  vault: VaultDriver,
  input: PutSnapshotInput,
): Promise<PersistSnapshotsResult> {
  const results = await Promise.allSettled(
    input.snapshots.map(async snapshot => {
      const item: VaultItem = {
        account: input.account,
        item: snapshot.itemId,
        metadata: {
          iv: '',
          modified: snapshot.modified,
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
  const persisted = persistedResults.length
  const logSeq = await vault.readLogHead({ account: input.account })

  return {
    success: persisted === input.snapshots.length,
    persisted,
    total: input.snapshots.length,
    results: persistedResults,
    logSeq,
  }
}

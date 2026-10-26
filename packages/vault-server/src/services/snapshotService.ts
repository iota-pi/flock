import type { z } from 'zod'
import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { PutSnapshotBatchSchema, ItemId } from '@vault/shared'

export type PutSnapshotInput = z.infer<typeof PutSnapshotBatchSchema>

export interface PersistSnapshotsResult {
  success: boolean
  persisted: number
  total: number
  results?: Array<{ itemId: ItemId; version: number }>
}

/**
 * Persists a batch of encrypted item snapshots into the vault,
 * records error diagnostics for any rejected writes.
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
      }

      const setResult = await vault.set(item)
      return {
        itemId: snapshot.itemId,
        version: setResult.version,
      }
    })
  )

  const persistedResults: Array<{ itemId: ItemId; version: number }> = []
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      persistedResults.push(result.value)
    } else {
      console.error(
        `[snapshotService.persistSnapshots] Failed to persist snapshot for item ${input.snapshots[index].itemId}:`,
        result.reason,
      )
    }
  })
  const persisted = persistedResults.length

  return {
    success: persisted === input.snapshots.length,
    persisted,
    total: input.snapshots.length,
    results: persistedResults,
  }
}

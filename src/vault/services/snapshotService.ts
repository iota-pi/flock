import type { z } from 'zod'
import type { VaultItem, VaultDriver } from '../drivers/base'
import type { PutSnapshotBatchSchema } from '../../shared/schemas/trpc'
import type { ItemType } from '../types'

import type { ItemId } from 'src/shared/schemas/items'
export type { VaultDriver }
export type PutSnapshotInput = z.infer<typeof PutSnapshotBatchSchema>

export interface PersistSnapshotsResult {
  success: boolean
  persisted: number
  total: number
  results?: Array<{ itemId: ItemId; version: number }>
}

export interface PersistSnapshotsOptions {
  now?: () => number
}

/**
 * Persists a batch of encrypted item snapshots into the vault,
 * records error diagnostics for any rejected writes, and advances
 * the account's lastSnapshotCursor and lastSnapshotAt if at least
 * one snapshot succeeded.
 */
export async function persistSnapshots(
  vault: VaultDriver,
  input: PutSnapshotInput,
  options?: PersistSnapshotsOptions,
): Promise<PersistSnapshotsResult> {
  const now = options?.now ?? Date.now

  const results = await Promise.allSettled(
    input.snapshots.map(async snapshot => {
      const item: VaultItem = {
        account: input.account,
        item: snapshot.itemId,
        metadata: {
          type: snapshot.type as ItemType,
          iv: '',
          modified: snapshot.modified,
          ...(snapshot.deleted ? { deleted: true } : {}),
        },
        snapshot: snapshot.snapshot,
      }

      const setResult = await vault.set(item)
      return {
        itemId: snapshot.itemId,
        version: setResult?.version ?? 1,
      }
    })
  )

  const persistedResults: Array<{ itemId: ItemId; version: number }> = []
  const persistedSnapshots = results
    .map((result, index) => {
      if (result.status === 'fulfilled') {
        persistedResults.push(result.value)
        return input.snapshots[index]
      }
      return null
    })
    .filter((snapshot): snapshot is typeof input.snapshots[number] => Boolean(snapshot))
  const persisted = persistedSnapshots.length

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(
        `[snapshotService.persistSnapshots] Failed to persist snapshot for item ${input.snapshots[index].itemId}:`,
        result.reason,
      )
    }
  })

  if (persisted > 0) {
    const snapshotCursor = Math.max(...persistedSnapshots.map(snapshot => snapshot.snapshotCursor))
    await vault.updateAccountData({
      account: input.account,
      lastSnapshotCursor: snapshotCursor,
      lastSnapshotAt: now(),
    })
  }

  return {
    success: persisted === input.snapshots.length,
    persisted,
    total: input.snapshots.length,
    results: persistedResults,
  }
}

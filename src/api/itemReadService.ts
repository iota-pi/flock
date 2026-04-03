import {
  fetchMany,
  getMetadata,
  type VaultMetadataEnvelope,
  type VaultItem,
} from './vault/client'
import * as vault from './vault'
import { trpcClient } from './trpcClient'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import { AccountMetadata } from '../state/metadata'
import { hasApiAuthToken } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import {
  queryClient,
  queryKeys,
} from './queryClient'
import { handleVaultError } from './runtime'
import migrateItems from '../state/migrations'
import { getAccountId } from './util'
import {
  getMutationId,
  readDeadLetterQueue,
  writeDeadLetterQueue,
} from '../sync/offlineQueueStore'
import { useUiStore } from '../state/uiStore'
import { emitSyncRuntimeMessage, setSyncRuntimeState } from '../sync/syncRuntime'
import * as Automerge from '@automerge/automerge'
import {
  setCachedAutomergeBinary,
  getCachedMetadataAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../sync/automergeBinaryCache'
import type { VaultEnvelope } from '../vault/types'
import {
  configureDecryptionWorkerCallbacks,
  decryptItemsInWorker,
  evaluateHistoryInWorker,
  maybeCompactItemInWorker,
} from '../workers/decryptionWorkerManager'
import { sharedDecryptionCache } from './vault/DecryptionCache'
import { getEnvelopeCacheKey } from './vault/decryptionCacheKey'
import { decryptAndMergeAutomerge } from './vault/decryptAndMergeAutomerge'
import { getLastSyncServerTime, setLastSyncServerTime } from '../sync/syncServerTimeStore'

const recoveryInFlightItemIds = new Set<ItemId>()
const recoveryCooldownUntilByItemId = new Map<ItemId, number>()
const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000
const MANUAL_RECOVERY_MUTATION_TYPE = 'items.manualRecovery'
let workerCallbacksConfigured = false

type WorkerResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

/**
 * Queue conflict resolutions for background sync
 * When multiple branches are detected and merged, push the resolution back to server
 *
 * This runs in the background and doesn't block the UI:
 * 1. Client receives multi-branch item from server (via WebSocket)
 * 2. Worker merges them deterministically
 * 3. Sends resolution back to server
 * 4. Server replaces multiple branches with single branch
 * 5. Broadcasts updated item to all clients
 */
async function queueConflictResolutions(
  resolutionItems: Array<{ itemId: ItemId; branch: { encryptedAutomergeDoc: string; versionId: string; parentIds: string[] } }>,
): Promise<void> {
  if (resolutionItems.length === 0) {
    return
  }

  try {
    // Only send resolutions if we're online
    if (!hasApiAuthToken()) {
      console.info(`[Automerge] Deferring conflict resolution - offline`)
      return
    }

    const account = getAccountId()
    const resolutions = resolutionItems.map(({ itemId, branch }) => ({
      item: itemId,
      resolvedBranch: branch,
    }))

    console.info(`[Automerge] Pushing conflict resolutions for ${resolutions.length} items`)

    // Send to server - this will replace multiple branches with single merged branch
    const response = await trpcClient.items.resolveBranchConflict.mutate({
      account,
      resolutions,
      idempotencyKey: `conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }) as any

    if (response?.success) {
      console.info(`[Automerge] ✓ Resolved ${response.resolvedCount} conflict(s)`)
    } else if (response?.failed && response.failed.length > 0) {
      console.warn(`[Automerge] Partially resolved - ${response.failed.length} failed:`, response.failed)
    }
  } catch (err) {
    // Silently fail - conflicts will be re-detected on next fetch
    console.error('[Automerge] Failed to push conflict resolution', err)
  }
}

function getRecoveryCooldownUntil(itemId: ItemId): number {
  return recoveryCooldownUntilByItemId.get(itemId) || 0
}

async function triggerManualRecoveryUI(itemId: ItemId, reason: string): Promise<void> {
  const deadLetterQueue = await readDeadLetterQueue()
  const existing = deadLetterQueue.find(item => (
    item.mutationType === MANUAL_RECOVERY_MUTATION_TYPE
    && typeof (item.payload as { itemId?: unknown })?.itemId === 'string'
    && (item.payload as { itemId: ItemId }).itemId === itemId
  ))

  if (!existing) {
    deadLetterQueue.push({
      id: getMutationId(),
      mutationType: MANUAL_RECOVERY_MUTATION_TYPE,
      payload: { itemId },
      endpoint: 'manual-recovery',
      queuedAt: Date.now(),
      failedAt: Date.now(),
      errorReason: reason,
      lastErrorStatus: 500,
    })
    await writeDeadLetterQueue(deadLetterQueue)
  }

  setSyncRuntimeState({ dlqCount: deadLetterQueue.length })
  emitSyncRuntimeMessage({
    severity: 'warning',
    message: 'A corrupted item could not be auto-recovered. Open Settings > Offline data recovery for manual repair.',
  })
}

async function evaluateHistoryWithWorker(
  key: CryptoKey,
  itemId: ItemId,
  history: VaultItem[],
): Promise<VaultItem | null> {
  if (history.length === 0) {
    return null
  }

  const result = await evaluateHistoryInWorker({
      key,
      itemId,
      history,
    }).catch(error => {
    handleVaultError(error as Error, `Failed to evaluate history for item ${itemId}`)
    return null
  })

  return result
}

async function attemptAutoRecovery(
  itemId: ItemId,
  failedBranches?: string[],
): Promise<void> {
  const now = Date.now()
  if (recoveryInFlightItemIds.has(itemId) || getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  recoveryInFlightItemIds.add(itemId)

  try {
    if (!hasApiAuthToken()) {
      return
    }

    const account = getAccountId()
    const historyResponse = await trpcClient.items.fetchItemHistory.query({
      account,
      itemId,
    }) as { success: boolean; history: VaultItem[] }

    if (!historyResponse.success || !Array.isArray(historyResponse.history) || historyResponse.history.length === 0) {
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'No history available for automated recovery')
      return
    }

    const key = vault.getVaultKey()
  const healthyEnvelope = await evaluateHistoryWithWorker(key, itemId, historyResponse.history)

    if (!healthyEnvelope) {
      console.error(`[Recovery] No healthy historical envelope found for item ${itemId}`, { failedBranches })
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'All historical revisions are corrupted')
      return
    }

    if (!healthyEnvelope.branches || healthyEnvelope.branches.length === 0) {
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'Historical recovery revision is not in branch format')
      return
    }

    await trpcClient.items.put.mutate({
      account,
      item: healthyEnvelope.item,
      branches: healthyEnvelope.branches,
      modified: Date.now(),
      type: healthyEnvelope.metadata.type,
      deleted: healthyEnvelope.metadata.deleted,
      idempotencyKey: `recovery-${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })

    recoveryCooldownUntilByItemId.delete(itemId)
    await queryClient.invalidateQueries({ queryKey: queryKeys.items })
    console.info(`[Recovery] Successfully rolled back item ${itemId}`)
  } catch (err) {
    console.error(`[Recovery] Auto-recovery failed for item ${itemId}`, err)
    recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
    await triggerManualRecoveryUI(itemId, 'Automated recovery attempt failed')
  } finally {
    recoveryInFlightItemIds.delete(itemId)
  }
}

function ensureDecryptionWorkerCallbacksConfigured(): void {
  if (workerCallbacksConfigured) {
    return
  }

  configureDecryptionWorkerCallbacks({
    onCorruptedItem: ({ itemId, failedBranches }) => {
      attemptAutoRecovery(itemId, failedBranches).catch(err => {
        console.error(`Failed to run auto-recovery for item ${itemId}`, err)
      })
    },
    onConflictResolved: ({ itemId, resolvedBranch }) => {
      queueConflictResolutions([{ itemId, branch: resolvedBranch }]).catch(err => {
        console.error('Failed to queue conflict resolution', err)
      })
    },
  })

  workerCallbacksConfigured = true
}

function assertNeverEnvelope(value: never): never {
  throw new Error(`Unhandled envelope kind: ${JSON.stringify(value)}`)
}

function toItemEnvelope(item: VaultItem): VaultEnvelope | null {
  if (typeof item.cipher === 'string') {
    return {
      kind: 'legacy',
      cipher: item.cipher,
      iv: item.metadata.iv,
    }
  }

  if (Array.isArray(item.branches)) {
    return {
      kind: 'branching',
      branches: item.branches,
    }
  }

  return null
}

function toMetadataEnvelope(metadata: VaultMetadataEnvelope): VaultEnvelope | null {
  if (metadata && typeof metadata === 'object' && 'branches' in metadata && Array.isArray(metadata.branches)) {
    return {
      kind: 'branching',
      branches: metadata.branches,
    }
  }

  if (metadata && typeof metadata === 'object' && 'cipher' in metadata && typeof metadata.cipher === 'string' && 'iv' in metadata && typeof metadata.iv === 'string') {
    return {
      kind: 'legacy',
      cipher: metadata.cipher,
      iv: metadata.iv,
    }
  }

  return null
}

// Fetch and decrypt all items - TanStack Query handles caching
export async function decryptVaultItems(items: VaultItem[]): Promise<Item[]> {
  ensureDecryptionWorkerCallbacksConfigured()

  const accountId = getAccountId()
  await sharedDecryptionCache.load(accountId)

  const fromCache: Item[] = []
  const toDecrypt: VaultItem[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.metadata?.deleted) {
      sharedDecryptionCache.delete(item.item)
      sharedDecryptionCache.schedulePersist(accountId)
      continue
    }

    const envelope = toItemEnvelope(item)
    if (!envelope) {
      handleVaultError(new Error(`Missing payload for item ${item.item ?? index}`), 'Failed to decrypt item from server')
      continue
    }

    const cacheKey = getEnvelopeCacheKey(envelope)
    const cached = sharedDecryptionCache.get(item.item)
    if (cached && cached.cacheKey === cacheKey) {
      fromCache.push(cached.item)
      continue
    }

    toDecrypt.push(item)
  }

  if (toDecrypt.length === 0) {
    return fromCache
  }

  const workerDecrypted = await decryptWithWorker(accountId, toDecrypt)
  return [...fromCache, ...workerDecrypted]
}

async function decryptWithWorker(accountId: string, items: VaultItem[]): Promise<Item[]> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    return decryptWithoutWorker(accountId, vault, items)
  }

  const key = vault.getVaultKey()
  const decrypted = await decryptItemsInWorker({ key, items }).catch(error => {
    handleVaultError(error as Error, 'Failed to decrypt item from server')
    return []
  })

  const sourcesById = new Map(items.map(item => [item.item, item]))

  return decrypted
    .map(item => {
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string') {
        return null
      }

      const workerItem = item as { automergeBinary?: unknown } & Record<string, unknown>
      const source = sourcesById.get(id)
      if (!source) {
        return null
      }

      const automergeBinary = workerItem.automergeBinary
      if (automergeBinary instanceof Uint8Array) {
        setCachedAutomergeBinary(id, automergeBinary)
        maybeCompactItemInWorker({
          key,
          source,
          automergeBinary,
          onCompacted: async compacted => {
            if (!hasApiAuthToken()) {
              return
            }

            await trpcClient.items.compactItem.mutate({
              account: getAccountId(),
              item: compacted.itemId,
              baseVersionId: compacted.baseVersionId,
              compactedBranch: compacted.compactedBranch,
              idempotencyKey: `compact-${compacted.itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            })

            setCachedAutomergeBinary(compacted.itemId, compacted.compactedBinary)

            const compactedEnvelope: VaultEnvelope = {
              kind: 'branching',
              branches: [compacted.compactedBranch],
            }
            const cached = sharedDecryptionCache.get(compacted.itemId)
            if (cached) {
              sharedDecryptionCache.set(compacted.itemId, {
                ...cached,
                cacheKey: getEnvelopeCacheKey(compactedEnvelope),
              })
              sharedDecryptionCache.schedulePersist(getAccountId())
            }
          },
          onError: error => {
            const itemId = source.item
            console.warn(`[Compaction] watcher failed for item ${itemId}`, error)
          },
        }).catch(error => {
          console.warn(`[Compaction] watcher failed for item ${id}`, error)
        })
      }

      const { automergeBinary: _automergeBinary, ...materialized } = workerItem

      const filled = supplyMissingAttributes(materialized as unknown as Item)

      const envelope = toItemEnvelope(source)
      if (!envelope) {
        return filled
      }

      sharedDecryptionCache.set(source.item, {
        cacheKey: getEnvelopeCacheKey(envelope),
        item: filled,
      })
      sharedDecryptionCache.schedulePersist(accountId)

      return filled
    })
    .filter((item): item is Item => !!item)
}

async function decryptWithoutWorker(
  accountId: string,
  vaultModule: typeof vault,
  items: VaultItem[],
): Promise<Item[]> {
  const decryptedResults = await Promise.allSettled(
    items.map(async source => {
      const envelope = toItemEnvelope(source)
      if (!envelope) {
        throw new Error(`Missing payload for item ${source.item}`)
      }

      let decrypted: Item
      switch (envelope.kind) {
        case 'legacy': {
          decrypted = await vaultModule.decryptObject({
            cipher: envelope.cipher,
            iv: envelope.iv,
          }) as Item
          break
        }
        case 'branching': {
          const merged = await decryptAndMergeAutomerge(envelope.branches, vaultModule.getVaultKey())
          decrypted = Automerge.toJS(merged.mergedDoc) as Item
          setCachedAutomergeBinary(source.item, merged.mergedBinary)
          break
        }
        default:
          assertNeverEnvelope(envelope)
      }

      const filled = supplyMissingAttributes(decrypted)

      sharedDecryptionCache.set(source.item, {
        cacheKey: getEnvelopeCacheKey(envelope),
        item: filled,
      })
      sharedDecryptionCache.schedulePersist(accountId)

      return filled
    }),
  )

  return decryptedResults.flatMap(result => {
    if (result.status === 'fulfilled') {
      return [result.value]
    }

    handleVaultError(result.reason as Error, 'Failed to decrypt item from server')
    return [] as Item[]
  })
}

export async function fetchItems(): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    // If API isn't ready to use (no auth token), we can't fetch.
    // Return empty array to satisfy the query temporarily.
    // The real fetch will happen once loadVault completes and triggers a refetch.
    return []
  }

  const cachedItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  const hasCachedItems = cachedItems.length > 0
  const accountId = getAccountId()
  const lastSyncServerTime = getLastSyncServerTime(accountId)
  const cacheTime = hasCachedItems && typeof lastSyncServerTime === 'number'
    ? lastSyncServerTime
    : null

  const response = await fetchMany({ cacheTime }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return { items: [] as VaultItem[], serverTime: lastSyncServerTime || 0 }
  })

  const items = response.items as VaultItem[]
  if (typeof response.serverTime === 'number' && response.serverTime > 0) {
    setLastSyncServerTime(accountId, response.serverTime)
  }

  const decrypted = await decryptVaultItems(items)
  const deletedIds = new Set(
    items
      .filter(item => item.metadata?.deleted === true)
      .map(item => item.item),
  )

  const mergedItems = cacheTime === null
    ? decrypted
    : mergeDeltaItems(cachedItems, decrypted, deletedIds)

  // Run migrations
  try {
    const metadata = await queryClient.fetchQuery({
      queryKey: queryKeys.metadata,
      queryFn: fetchMetadata,
      staleTime: 5 * 60 * 1000,
    })
    await migrateItems(mergedItems, metadata)
  } catch (err) {
    console.error('Migration check failed during fetchItems', err)
  }

  return sortItems(mergedItems, DEFAULT_CRITERIA)
}

function mergeDeltaItems(existing: Item[], delta: Item[], deletedIds: Set<string>): Item[] {
  const mergedMap = new Map(
    existing
      .filter(item => !deletedIds.has(item.id))
      .map(item => [item.id, item]),
  )

  for (const item of delta) {
    mergedMap.set(item.id, item)
  }

  return Array.from(mergedMap.values())
}

// Fetch and decrypt metadata
export async function fetchMetadata(): Promise<AccountMetadata> {
  const result = await getMetadata()

  const envelope = toMetadataEnvelope(result)
  if (envelope) {
    switch (envelope.kind) {
      case 'branching': {
        const merged = await decryptAndMergeAutomerge(envelope.branches, vault.getVaultKey())
        setCachedMetadataAutomergeBinary(merged.mergedBinary)
        return Automerge.toJS(merged.mergedDoc) as AccountMetadata
      }
      case 'legacy': {
        const metadata = await vault.decryptObject({
          cipher: envelope.cipher,
          iv: envelope.iv,
        }) as AccountMetadata
        const doc = Automerge.from(metadata as unknown as Record<string, unknown>)
        setCachedMetadataAutomergeBinary(Automerge.save(doc))
        return metadata
      }
      default:
        assertNeverEnvelope(envelope)
    }
  }

  const metadata = (result || {}) as AccountMetadata
  const fallbackBinary = getCachedMetadataAutomergeBinary() || Automerge.save(Automerge.from(metadata as Record<string, unknown>))
  setCachedMetadataAutomergeBinary(fallbackBinary)
  return metadata
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}

import { useMutation, useQuery } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'
import {
  vaultFetchMany,
  vaultGetMetadata,
  type VaultItem,
} from './VaultAPI'
import { trpcClient } from './trpcClient'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import { AccountMetadata } from '../state/metadata'
import { checkAxios } from './axios'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import {
  mutateDeleteItems,
  mutateSetMetadata,
  mutateStoreItems,
} from './mutations'
import {
  queryClient,
  queryKeys,
  clearQueryCache as clearQueryClientCache,
} from './queryClient'
import { handleVaultError } from './runtime'
import migrateItems from '../state/migrations'
import { getAccountId } from './util'
import { syncDB } from './db'

// Crypto helpers - these need the key from Vault.ts, so we import dynamically
async function getVaultModule() {
  return import('./Vault')
}

// Cache for decrypted items
const decryptionCache = new Map<string, { cacheKey: string, item: Item }>()
const DECRYPTION_CACHE_KEY_PREFIX = 'decryption-cache'
const MAX_DECRYPTION_CACHE_ITEMS = 2000
let inMemoryLastSyncServerTime: number | null = null
let loadedDecryptionCacheAccountId: string | null = null
let decryptionCacheWriteTimer: ReturnType<typeof setTimeout> | null = null

let sharedDecryptionWorker: Worker | null = null
let decryptionJobCounter = 0
const pendingDecryptionJobs = new Map<number, {
  resolve: (value: object[]) => void
  reject: (reason?: unknown) => void
}>()
const pendingHistoryEvaluationJobs = new Map<number, {
  resolve: (value: VaultItem | null) => void
  reject: (reason?: unknown) => void
}>()
const recoveryInFlightItemIds = new Set<string>()
const recoveryCooldownUntilByItemId = new Map<string, number>()
const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000

type WorkerResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

function getDecryptionCacheKey(accountId: string): string {
  return `${DECRYPTION_CACHE_KEY_PREFIX}_${accountId}`
}

async function loadDecryptionCache(accountId: string): Promise<void> {
  if (loadedDecryptionCacheAccountId === accountId) {
    return
  }

  const persisted = await syncDB.getItem<Record<string, any>>(getDecryptionCacheKey(accountId))
  decryptionCache.clear()

  if (persisted) {
    for (const [key, value] of Object.entries(persisted)) {
      // Support both old format (with cipher/iv) and new format (with cacheKey)
      if ('cacheKey' in value && 'item' in value) {
        decryptionCache.set(key, value)
      } else if ('cipher' in value && 'iv' in value && 'item' in value) {
        // Migrate old format to new format
        decryptionCache.set(key, {
          cacheKey: value.cipher,
          item: value.item,
        })
      }
    }
  }

  loadedDecryptionCacheAccountId = accountId
}

function schedulePersistDecryptionCache(accountId: string): void {
  if (decryptionCacheWriteTimer) {
    clearTimeout(decryptionCacheWriteTimer)
  }

  decryptionCacheWriteTimer = setTimeout(() => {
    if (decryptionCache.size > MAX_DECRYPTION_CACHE_ITEMS) {
      const entries = Array.from(decryptionCache.entries())
      const newestEntries = entries.slice(entries.length - MAX_DECRYPTION_CACHE_ITEMS)
      decryptionCache.clear()
      for (const [key, value] of newestEntries) {
        decryptionCache.set(key, value)
      }
    }

    const snapshot = Object.fromEntries(decryptionCache.entries())
    void syncDB.setItem(getDecryptionCacheKey(accountId), snapshot)
  }, 200)
}

function resetDecryptionCacheForTests(): void {
  if (decryptionCacheWriteTimer) {
    clearTimeout(decryptionCacheWriteTimer)
  }
  decryptionCacheWriteTimer = null
  decryptionCache.clear()
  loadedDecryptionCacheAccountId = null
}

function getDecryptionCacheSnapshotForTests() {
  return new Map(decryptionCache)
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
  resolutionItems: Array<{ itemId: string; branch: { encryptedAutomergeDoc: string; versionId: string; parentIds: string[] } }>,
): Promise<void> {
  if (resolutionItems.length === 0) {
    return
  }

  try {
    // Only send resolutions if we're online
    if (!checkAxios()) {
      console.log(`[Automerge] Deferring conflict resolution - offline`)
      return
    }

    const account = getAccountId()
    const resolutions = resolutionItems.map(({ itemId, branch }) => ({
      item: itemId,
      resolvedBranch: branch,
    }))

    console.log(`[Automerge] Pushing conflict resolutions for ${resolutions.length} items`)

    // Send to server - this will replace multiple branches with single merged branch
    const response = await trpcClient.items.resolveBranchConflict.mutate({
      account,
      resolutions,
      idempotencyKey: `conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }) as any

    if (response?.success) {
      console.log(`[Automerge] ✓ Resolved ${response.resolvedCount} conflict(s)`)
    } else if (response?.failed && response.failed.length > 0) {
      console.warn(`[Automerge] Partially resolved - ${response.failed.length} failed:`, response.failed)
    }
  } catch (err) {
    // Silently fail - conflicts will be re-detected on next fetch
    console.error('[Automerge] Failed to push conflict resolution', err)
  }
}

function getRecoveryCooldownUntil(itemId: string): number {
  return recoveryCooldownUntilByItemId.get(itemId) || 0
}

async function evaluateHistoryWithWorker(
  worker: Worker,
  key: CryptoKey,
  itemId: string,
  history: VaultItem[],
): Promise<VaultItem | null> {
  if (history.length === 0) {
    return null
  }

  decryptionJobCounter += 1
  const jobId = decryptionJobCounter

  const result = await new Promise<VaultItem | null>((resolve, reject) => {
    pendingHistoryEvaluationJobs.set(jobId, { resolve, reject })
    worker.postMessage({
      type: 'EVALUATE_HISTORY',
      jobId,
      key,
      itemId,
      history,
    })
  }).catch(error => {
    handleVaultError(error as Error, `Failed to evaluate history for item ${itemId}`)
    pendingHistoryEvaluationJobs.delete(jobId)
    return null
  })

  return result
}

async function attemptAutoRecovery(
  worker: Worker,
  itemId: string,
  failedBranches?: string[],
): Promise<void> {
  const now = Date.now()
  if (recoveryInFlightItemIds.has(itemId) || getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  recoveryInFlightItemIds.add(itemId)

  try {
    if (!checkAxios()) {
      return
    }

    const account = getAccountId()
    const historyResponse = await trpcClient.items.fetchItemHistory.query({
      account,
      itemId,
    }) as { success: boolean; history: VaultItem[] }

    if (!historyResponse.success || !Array.isArray(historyResponse.history) || historyResponse.history.length === 0) {
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      return
    }

    const vault = await getVaultModule()
    const key = vault.getVaultKey()
    const healthyEnvelope = await evaluateHistoryWithWorker(worker, key, itemId, historyResponse.history)

    if (!healthyEnvelope) {
      console.error(`[Recovery] No healthy historical envelope found for item ${itemId}`, { failedBranches })
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      return
    }

    await trpcClient.items.put.mutate({
      account,
      item: healthyEnvelope.item,
      ...(healthyEnvelope.cipher ? { cipher: healthyEnvelope.cipher } : {}),
      ...(healthyEnvelope.branches ? { branches: healthyEnvelope.branches } : {}),
      iv: healthyEnvelope.metadata.iv,
      modified: Date.now(),
      type: healthyEnvelope.metadata.type,
      deleted: healthyEnvelope.metadata.deleted,
      idempotencyKey: `recovery-${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    } as any)

    recoveryCooldownUntilByItemId.delete(itemId)
    await queryClient.invalidateQueries({ queryKey: queryKeys.items })
    console.log(`[Recovery] Successfully rolled back item ${itemId}`)
  } catch (err) {
    console.error(`[Recovery] Auto-recovery failed for item ${itemId}`, err)
    recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
  } finally {
    recoveryInFlightItemIds.delete(itemId)
  }
}

function ensureSharedDecryptionWorker(): Worker {
  if (sharedDecryptionWorker) {
    return sharedDecryptionWorker
  }

  const worker = new Worker(
    new URL('../workers/decryption.worker.ts', import.meta.url),
    { type: 'module' },
  )

  worker.onmessage = event => {
    const payload = event.data as {
      type?: unknown
      jobId?: unknown
      items?: object[]
      itemId?: unknown
      failedBranches?: unknown
      resolvedBranch?: WorkerResolvedBranch
      healthyEnvelope?: VaultItem | null
      resolutionItems?: Array<{ itemId: string; branch: WorkerResolvedBranch }>
    }

    if (payload.type === 'CORRUPTED_ITEM_DETECTED') {
      if (typeof payload.itemId === 'string') {
        const failedBranches = Array.isArray(payload.failedBranches)
          ? payload.failedBranches.filter((value): value is string => typeof value === 'string')
          : undefined

        attemptAutoRecovery(worker, payload.itemId, failedBranches).catch(err => {
          console.error(`Failed to run auto-recovery for item ${payload.itemId}`, err)
        })
      }
      return
    }

    if (payload.type === 'HISTORY_EVALUATED') {
      const jobId = typeof payload.jobId === 'number' ? payload.jobId : -1
      const pending = pendingHistoryEvaluationJobs.get(jobId)
      if (!pending) {
        return
      }

      pendingHistoryEvaluationJobs.delete(jobId)
      pending.resolve((payload.healthyEnvelope as VaultItem | null) || null)
      return
    }

    if (payload.type === 'CONFLICT_RESOLVED') {
      if (typeof payload.itemId === 'string' && payload.resolvedBranch) {
        queueConflictResolutions([{ itemId: payload.itemId, branch: payload.resolvedBranch }]).catch(err => {
          console.error('Failed to queue conflict resolution', err)
        })
      }
      return
    }

    if (payload.type !== 'DECRYPTION_RESULT' && payload.type !== undefined) {
      return
    }

    const jobId = typeof payload.jobId === 'number' ? payload.jobId : -1
    const pending = pendingDecryptionJobs.get(jobId)
    if (!pending) {
      return
    }

    pendingDecryptionJobs.delete(jobId)

    // Backward compatibility for older worker payloads.
    if (payload.resolutionItems && payload.resolutionItems.length > 0) {
      queueConflictResolutions(payload.resolutionItems).catch(err => {
        console.error('Failed to queue conflict resolutions', err)
      })
    }

    pending.resolve(payload.items || [])
  }

  worker.onerror = event => {
    const error = new Error(event.message || 'Worker decryption failed')
    for (const pending of pendingDecryptionJobs.values()) {
      pending.reject(error)
    }
    pendingDecryptionJobs.clear()

    for (const pending of pendingHistoryEvaluationJobs.values()) {
      pending.reject(error)
    }
    pendingHistoryEvaluationJobs.clear()

    sharedDecryptionWorker = null
  }

  sharedDecryptionWorker = worker
  return worker
}

function getLastSyncServerTimeKey(accountId: string): string {
  return `lastSyncServerTime_${accountId}`
}

function getLastSyncServerTime(accountId: string): number | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return inMemoryLastSyncServerTime
  }

  const rawValue = window.localStorage.getItem(getLastSyncServerTimeKey(accountId))
  if (!rawValue) {
    return null
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function setLastSyncServerTime(accountId: string, serverTime: number): void {
  inMemoryLastSyncServerTime = serverTime
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }

  window.localStorage.setItem(getLastSyncServerTimeKey(accountId), serverTime.toString())
}

// Fetch and decrypt all items - TanStack Query handles caching
export async function decryptVaultItems(items: VaultItem[]): Promise<Item[]> {
  const accountId = getAccountId()
  await loadDecryptionCache(accountId)

  const fromCache: Item[] = []
  const toDecrypt: VaultItem[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.metadata?.deleted) {
      decryptionCache.delete(item.item)
      schedulePersistDecryptionCache(accountId)
      continue
    }

    // Support both legacy cipher and branches format
    const cipher = item.cipher
    const branches = item.branches
    const iv = item.metadata?.iv

    // Check if item has valid payload (either cipher or branches)
    if (!cipher && !branches) {
      handleVaultError(new Error(`Missing payload for item ${item.item ?? index}`), 'Failed to decrypt item from server')
      continue
    }

    // Try cache lookup (using cipher for legacy items)
    const cacheKey = cipher || (branches ? `branches-${branches[0]?.versionId}` : undefined)
    if (cacheKey) {
      const cached = decryptionCache.get(item.item)
      if (cached && cached.cacheKey === cacheKey) {
        fromCache.push(cached.item)
        continue
      }
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
  const vault = await getVaultModule()

  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    return decryptWithoutWorker(accountId, vault, items)
  }

  const key = vault.getVaultKey()
  const worker = ensureSharedDecryptionWorker()
  decryptionJobCounter += 1
  const jobId = decryptionJobCounter

  const decrypted = await new Promise<object[]>((resolve, reject) => {
    pendingDecryptionJobs.set(jobId, { resolve, reject })
    worker.postMessage({ type: 'DECRYPT_ITEMS', jobId, key, items })
  }).catch(error => {
    handleVaultError(error as Error, 'Failed to decrypt item from server')
    pendingDecryptionJobs.delete(jobId)
    return []
  })

  const sourcesById = new Map(items.map(item => [item.item, item]))

  return decrypted
    .map(item => {
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string') {
        return null
      }

      const source = sourcesById.get(id)
      if (!source) {
        return null
      }

      const filled = supplyMissingAttributes(item as Item)
      if (typeof source.metadata?.version === 'number') {
        filled.version = source.metadata.version
      }

      // Generate cache key based on format
      const cacheKey = source.cipher || (source.branches ? `branches-${source.branches[0]?.versionId}` : '')
      decryptionCache.set(source.item, {
        cacheKey,
        item: filled,
      })
      schedulePersistDecryptionCache(accountId)

      return filled
    })
    .filter((item): item is Item => !!item)
}

async function decryptWithoutWorker(
  accountId: string,
  vault: Awaited<ReturnType<typeof getVaultModule>>,
  items: VaultItem[],
): Promise<Item[]> {
  const decryptedResults = await Promise.allSettled(
    items.map(async source => {
      // Only support legacy cipher format in fallback (no worker)
      if (!source.cipher) {
        throw new Error(`Cannot decrypt branching format without worker`)
      }

      const decrypted = await vault.decryptObject({ cipher: source.cipher, iv: source.metadata.iv }) as Item
      const filled = supplyMissingAttributes(decrypted)

      if (typeof source.metadata?.version === 'number') {
        filled.version = source.metadata.version
      }

      decryptionCache.set(source.item, {
        cacheKey: source.cipher,
        item: filled,
      })
      schedulePersistDecryptionCache(accountId)

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
  if (!checkAxios()) {
    // If Axios isn't ready, we can't fetch.
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

  const response = await vaultFetchMany({ cacheTime }).catch(error => {
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
  const vault = await getVaultModule()
  const result = await vaultGetMetadata()
  let metadata: AccountMetadata

  if (result && 'cipher' in result && 'iv' in result) {
    metadata = await vault.decryptObject(result as { cipher: string; iv: string }) as AccountMetadata
    // Add version if it was passed alongside
    if ('version' in result && typeof result.version === 'number') {
      metadata.version = result.version
    }
  } else {
    // Backwards compatibility (10/07/21)
    metadata = result as AccountMetadata
  }
  return metadata
}

// Hook: Fetch items
export function useItemsQuery<TData = Item[]>(
  options?: Omit<UseQueryOptions<Item[], Error, TData>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.items,
    queryFn: fetchItems,
    enabled: options?.enabled ?? true,
  })
}

// Hook: Fetch metadata
export function useMetadataQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.metadata,
    queryFn: fetchMetadata,
    enabled,
  })
}

// Hook: Update metadata
export function useSetMetadataMutation() {
  return useMutation<AccountMetadata, Error, AccountMetadata | ((prev: AccountMetadata) => AccountMetadata), { previousMetadata: AccountMetadata | undefined }>({
    mutationFn: mutateSetMetadata,
    onMutate: async variables => {
      await queryClient.cancelQueries({ queryKey: queryKeys.metadata })

      const previousMetadata = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata)
      const nextMetadata = typeof variables === 'function'
        ? variables(previousMetadata || {} as AccountMetadata)
        : variables

      queryClient.setQueryData<AccountMetadata>(queryKeys.metadata, nextMetadata)

      return { previousMetadata }
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(queryKeys.metadata, context?.previousMetadata)
    },
  })
}

// Hook: Store items mutation
export function useStoreItemsMutation() {
  return useMutation<Item[], Error, Item | Item[]>({
    mutationFn: items => mutateStoreItems(items),
  })
}

// Hook: Delete items mutation
export function useDeleteItemsMutation() {
  return useMutation({
    mutationFn: mutateDeleteItems,
  })
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  clearQueryClientCache()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}

export const __decryptionCacheTestUtils = {
  getSnapshot: getDecryptionCacheSnapshotForTests,
  load: loadDecryptionCache,
  reset: resetDecryptionCacheForTests,
  schedulePersist: schedulePersistDecryptionCache,
}

import {
  fetchMany,
  getMetadata,
  setMetadata as pushMetadata,
  type VaultItem,
} from './vault/client'
import * as vault from './vault'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import { AccountMetadata } from '../state/metadata'
import { getApiAuthToken, hasApiAuthToken, handleVaultError  } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { getAccountId } from './util'
import {
  decryptItemsInWorker,
  type WorkerDecryptedItem,
} from '../workers/decryptionWorkerManager'
import { sharedDecryptionCache } from './vault/DecryptionCache'
import { getEnvelopeCacheKey } from './vault/decryptionCacheKey'
import { decryptVaultEnvelope } from './vault/decryptVaultEnvelope'
import { getLastSyncServerTime } from '../sync/syncServerTimeStore'
import {
  clearManualRecoveryForItems,
  initializeSyncHealthWatchers,
  reportDecryptionFailure,
} from './syncHealthCoordinator'
import { parseVaultEnvelope } from './vault/envelopeParser'
import { enqueueCompactionCandidate } from './vault/maintenanceCoordinator'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  receiveAutomergeSyncMessage,
  writeAutomergeSyncCursor,
} from '../sync/automergeDocStore'
import { ITEM_TYPES } from '../shared/itemTypes'
import { decryptBytesWithKey } from './vault/crypto'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

const bootstrapPromiseByScope = new Map<string, Promise<void>>()
const completedBootstrapScopes = new Set<string>()
const metadataPromiseByScope = new Map<string, Promise<AccountMetadata>>()
const metadataSubscribers = new Set<() => void>()
const pendingMetadataByScope = new Map<string, AccountMetadata>()
const metadataSyncInFlightScopes = new Set<string>()
const metadataSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let cachedMetadata: AccountMetadata = {}
let cachedMetadataScope = ''
const METADATA_SYNC_RETRY_DELAY_MS = 5 * 1000

type FetchItemsOptions = {
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type EnsureItemsBootstrapOptions = FetchItemsOptions & {
  force?: boolean
}

type SyncSnapshotMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
  }
}

function getBootstrapScopeKey(accountId: string): string {
  return `${accountId}:${getApiAuthToken()}`
}

function getMetadataScopeKey(accountId: string): string {
  return `${accountId}:${getApiAuthToken()}`
}

function notifyMetadataSubscribers(): void {
  for (const subscriber of metadataSubscribers) {
    subscriber()
  }
}

function setCachedMetadataSnapshot(metadata: AccountMetadata, scopeKey: string): void {
  cachedMetadata = metadata || {}
  cachedMetadataScope = scopeKey
  notifyMetadataSubscribers()
}

function clearMetadataSyncRetry(scopeKey: string): void {
  const timer = metadataSyncRetryTimers.get(scopeKey)
  if (!timer) {
    return
  }

  clearTimeout(timer)
  metadataSyncRetryTimers.delete(scopeKey)
}

async function flushPendingMetadataSync(accountId: string, scopeKey: string): Promise<void> {
  if (!hasApiAuthToken() || metadataSyncInFlightScopes.has(scopeKey)) {
    return
  }

  const pendingMetadata = pendingMetadataByScope.get(scopeKey)
  if (!pendingMetadata) {
    clearMetadataSyncRetry(scopeKey)
    return
  }

  metadataSyncInFlightScopes.add(scopeKey)

  try {
    await pushMetadata(pendingMetadata as Record<string, unknown>)

    if (pendingMetadataByScope.get(scopeKey) === pendingMetadata) {
      pendingMetadataByScope.delete(scopeKey)
    }

    clearMetadataSyncRetry(scopeKey)
  } catch (_) {
    if (!metadataSyncRetryTimers.has(scopeKey)) {
      metadataSyncRetryTimers.set(scopeKey, setTimeout(() => {
        metadataSyncRetryTimers.delete(scopeKey)
        void flushPendingMetadataSync(accountId, scopeKey)
      }, METADATA_SYNC_RETRY_DELAY_MS))
    }
  } finally {
    metadataSyncInFlightScopes.delete(scopeKey)

    if (pendingMetadataByScope.has(scopeKey) && hasApiAuthToken()) {
      void flushPendingMetadataSync(accountId, scopeKey)
    }
  }
}

export function getCachedMetadata(): AccountMetadata {
  return cachedMetadata
}

export function subscribeMetadata(listener: () => void): () => void {
  metadataSubscribers.add(listener)
  return () => {
    metadataSubscribers.delete(listener)
  }
}

export function clearMetadataCache(): void {
  const hadSnapshot = Object.keys(cachedMetadata).length > 0 || cachedMetadataScope.length > 0

  cachedMetadata = {}
  cachedMetadataScope = ''
  metadataPromiseByScope.clear()
  pendingMetadataByScope.clear()
  metadataSyncInFlightScopes.clear()

  for (const scopeKey of metadataSyncRetryTimers.keys()) {
    clearMetadataSyncRetry(scopeKey)
  }

  if (hadSnapshot) {
    notifyMetadataSubscribers()
  }
}

export function setCachedMetadata(metadata: AccountMetadata): void {
  setCachedMetadataSnapshot(metadata || {}, getMetadataScopeKey(getAccountId()))
}

export function queueMetadataForSync(
  metadata: AccountMetadata,
  accountId = getAccountId(),
): void {
  const scopeKey = getMetadataScopeKey(accountId)
  pendingMetadataByScope.set(scopeKey, metadata || {})
  void flushPendingMetadataSync(accountId, scopeKey)
}

export function requestMetadataSync(accountId = getAccountId()): void {
  const scopeKey = getMetadataScopeKey(accountId)
  void flushPendingMetadataSync(accountId, scopeKey)
}

export async function ensureMetadataLoaded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  if (!hasApiAuthToken()) {
    clearMetadataCache()
    return {}
  }

  const scopeKey = getMetadataScopeKey(accountId)

  if (pendingMetadataByScope.has(scopeKey) && cachedMetadataScope === scopeKey) {
    return cachedMetadata
  }

  if (!options.force && cachedMetadataScope === scopeKey) {
    return cachedMetadata
  }

  const inFlight = metadataPromiseByScope.get(scopeKey)
  if (inFlight) {
    return inFlight
  }

  const loadPromise = fetchMetadata(accountId)
    .catch(error => {
      handleVaultError(error, 'Failed to fetch metadata')
      return cachedMetadataScope === scopeKey ? cachedMetadata : {}
    })
    .finally(() => {
      metadataPromiseByScope.delete(scopeKey)
    })

  metadataPromiseByScope.set(scopeKey, loadPromise)
  return loadPromise
}

function getOrderedSyncSnapshotMessages(item: VaultItem): SyncSnapshotMessage[] {
  if (!Array.isArray(item.syncMessages) || item.syncMessages.length === 0) {
    return []
  }

  const validMessages = item.syncMessages.filter(message => (
    typeof message?.cursor === 'number'
    && message.cursor > 0
    && typeof message?.encryptedMessage?.iv === 'string'
    && typeof message?.encryptedMessage?.cipher === 'string'
  )) as SyncSnapshotMessage[]

  validMessages.sort((left, right) => left.cursor - right.cursor)
  return validMessages
}

async function bootstrapItemsFromSyncMessages(accountId: string): Promise<void> {
  if (!hasApiAuthToken()) {
    return
  }

  await initializeAutomergeDocStore(accountId)

  const response = await fetchMany({ cacheTime: null }).catch(error => {
    handleVaultError(error, 'Failed to fetch sync snapshot from server')
    return { items: [] as VaultItem[], serverTime: getLastSyncServerTime(accountId) || 0, success: false }
  })

  const responseItems = response.items as VaultItem[]
  const itemIds: string[] = []

  for (const item of responseItems) {
    if (typeof item.item !== 'string' || item.item.length === 0) {
      continue
    }

    itemIds.push(item.item)

    const orderedMessages = getOrderedSyncSnapshotMessages(item)
    if (orderedMessages.length === 0) {
      continue
    }

    let highestCursor = 0
    for (const message of orderedMessages) {
      try {
        const decryptedMessage = await decryptBytesWithKey(vault.getVaultKey(), message.encryptedMessage)
        const changed = await receiveAutomergeSyncMessage(item.item, decryptedMessage)
        if (changed) {
          highestCursor = Math.max(highestCursor, message.cursor)
        }
      } catch (error) {
        reportDecryptionFailure({
          source: 'main-thread',
          itemId: item.item,
          error,
        })
      }
    }

    if (highestCursor > 0) {
      await writeAutomergeSyncCursor(item.item, highestCursor)
    }
  }

  if (itemIds.length > 0) {
    requestAutomergeSync(itemIds)
  }
}

type DecryptionResult =
  | { ok: true; item: Item }
  | { ok: false; itemId?: string; error: unknown }

function collectSuccessfulDecryptions(
  source: 'worker' | 'main-thread',
  results: DecryptionResult[],
): Item[] {
  const successful: Item[] = []
  for (const result of results) {
    if (result.ok) {
      successful.push(result.item)
      continue
    }

    reportDecryptionFailure({
      source,
      itemId: result.itemId,
      error: result.error,
    })
  }

  if (successful.length > 0) {
    void clearManualRecoveryForItems(successful.map(item => item.id)).catch(() => undefined)
  }

  return successful
}

// Fetch and decrypt all items from local-first state
export async function decryptVaultItems(items: VaultItem[]): Promise<Item[]> {
  initializeSyncHealthWatchers()

  const accountId = getAccountId()
  await sharedDecryptionCache.load(accountId)

  const fromCache: Item[] = []
  const toDecrypt: VaultItem[] = []
  let cacheMutated = false

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.metadata?.deleted) {
      sharedDecryptionCache.delete(item.item)
      cacheMutated = true
      continue
    }

    const envelope = parseVaultEnvelope(item)
    if (!envelope) {
      reportDecryptionFailure({
        source: 'main-thread',
        itemId: item.item,
        error: new Error(`Missing payload for item ${item.item ?? index}`),
      })
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
    if (cacheMutated) {
      sharedDecryptionCache.schedulePersist(accountId)
    }
    return fromCache
  }

  const workerDecrypted = await decryptWithWorker(accountId, toDecrypt)
  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }
  return [...fromCache, ...workerDecrypted]
}

async function decryptWithWorker(accountId: string, items: VaultItem[]): Promise<Item[]> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    return decryptWithoutWorker(accountId, vault, items)
  }

  const key = vault.getVaultKey()
  const decrypted = await decryptItemsInWorker({ key, items }).catch(error => {
    reportDecryptionFailure({
      source: 'worker',
      error,
    })
    return []
  })

  const sourcesById = new Map(items.map(item => [item.item, item]))
  let cacheMutated = false

  const results = decrypted.map((workerItem: WorkerDecryptedItem) => {
    const source = sourcesById.get(workerItem.id)
    if (!source) {
      return {
        ok: false,
        itemId: workerItem.id,
        error: new Error(`Worker returned unknown item id: ${workerItem.id}`),
      } satisfies DecryptionResult
    }

    try {
      const automergeBinary = workerItem.automergeBinary
      if (automergeBinary instanceof Uint8Array) {
        enqueueCompactionCandidate({ source, automergeBinary })
      }

      const { automergeBinary: _automergeBinary, ...materialized } = workerItem
      const hydrated = hydrateAndCacheItem(
        accountId,
        source,
        materialized as Partial<Item>,
        automergeBinary,
      )

      if (hydrated.cacheUpdated) {
        cacheMutated = true
      }

      return {
        ok: true,
        item: hydrated.item,
      } satisfies DecryptionResult
    } catch (error) {
      return {
        ok: false,
        itemId: source.item,
        error,
      } satisfies DecryptionResult
    }
  })

  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }

  return collectSuccessfulDecryptions('worker', results)
}

async function decryptWithoutWorker(
  accountId: string,
  vaultModule: typeof vault,
  items: VaultItem[],
): Promise<Item[]> {
  let cacheMutated = false
  const decryptedResults = await Promise.allSettled(
    items.map(async source => {
      const envelope = parseVaultEnvelope(source)
      if (!envelope) {
        throw new Error(`Missing payload for item ${source.item}`)
      }

      const decrypted = await decryptVaultEnvelope<Item>({
        envelope,
        key: vaultModule.getVaultKey(),
        decryptLegacyEnvelope: vaultModule.decryptObject,
      })

      const hydrated = hydrateAndCacheItem(
        accountId,
        source,
        decrypted.materialized as Partial<Item>,
        decrypted.automergeBinary,
      )

      if (hydrated.cacheUpdated) {
        cacheMutated = true
      }

      return {
        ok: true,
        item: hydrated.item,
      } satisfies DecryptionResult
    }),
  )

  const results = decryptedResults.map(result => (
    result.status === 'fulfilled'
      ? result.value
      : {
        ok: false,
        error: result.reason,
      } satisfies DecryptionResult
  ))

  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }

  return collectSuccessfulDecryptions('main-thread', results)
}

export async function fetchItems(options: FetchItemsOptions = {}): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    return []
  }

  const accountId = getAccountId()
  if (options.forceMetadataRefetch) {
    await ensureMetadataLoaded(accountId, { force: true })
  }

  await ensureItemsBootstrap(accountId, {
    force: options.forceFullSync,
  })
  const visibleItems = getAutomergeItems()

  return sortItems(visibleItems, DEFAULT_CRITERIA)
}

export function ensureItemsBootstrap(accountId: string, options: EnsureItemsBootstrapOptions = {}): Promise<void> {
  const scopeKey = getBootstrapScopeKey(accountId)

  if (!options.force && completedBootstrapScopes.has(scopeKey)) {
    return Promise.resolve()
  }

  const inFlight = bootstrapPromiseByScope.get(scopeKey)
  if (inFlight) {
    return inFlight
  }

  const bootstrap = bootstrapItemsFromSyncMessages(accountId)
    .then(() => {
      completedBootstrapScopes.add(scopeKey)
    })
    .then(() => undefined)
    .finally(() => {
      bootstrapPromiseByScope.delete(scopeKey)
    })

  bootstrapPromiseByScope.set(scopeKey, bootstrap)
  return bootstrap
}

// Fetch and decrypt metadata
export async function fetchMetadata(accountId = getAccountId()): Promise<AccountMetadata> {
  const result = await getMetadata()
  const scopeKey = getMetadataScopeKey(accountId)

  const envelope = parseVaultEnvelope(result)
  if (envelope) {
    const decrypted = await decryptVaultEnvelope<AccountMetadata>({
      envelope,
      key: vault.getVaultKey(),
      decryptLegacyEnvelope: vault.decryptObject,
    })

    if (decrypted.automergeBinary) {
      sharedDecryptionCache.setMetadataBinary(decrypted.automergeBinary)
    }

    const metadata = decrypted.materialized
    setCachedMetadataSnapshot(metadata, scopeKey)
    return metadata
  }

  const metadata = (result || {}) as AccountMetadata
  setCachedMetadataSnapshot(metadata, scopeKey)
  return metadata
}

function hydrateAndCacheItem(
  accountId: string,
  source: VaultItem,
  materializedItem: Partial<Item>,
  automergeBinary?: Uint8Array,
): { item: Item; cacheUpdated: boolean } {
  const workerType = (materializedItem as { type?: unknown }).type
  const metadataType = source.metadata?.type
  const resolvedType = ITEM_TYPES.includes(workerType as Item['type'])
    ? workerType
    : (ITEM_TYPES.includes(metadataType as Item['type']) ? metadataType : undefined)
  const normalized = {
    ...materializedItem,
    id: typeof materializedItem.id === 'string' ? materializedItem.id : source.item,
    type: resolvedType,
  } as Partial<Item>
  const filled = supplyMissingAttributes(normalized as Item)
  const envelope = parseVaultEnvelope(source)

  if (!envelope) {
    return { item: filled, cacheUpdated: false }
  }

  sharedDecryptionCache.set(source.item, {
    cacheKey: getEnvelopeCacheKey(envelope),
    item: filled,
    automergeBinary: automergeBinary instanceof Uint8Array ? automergeBinary : undefined,
  })

  return { item: filled, cacheUpdated: true }
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}

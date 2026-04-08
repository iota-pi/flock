import {
  fetchMany,
  getMetadata,
  setMetadata as pushMetadata,
  type VaultItem,
} from './vault/client'
import * as vault from './vault'
import type { Item } from '../state/items'
import { AccountMetadata } from '../state/metadata'
import { getApiAuthToken, hasApiAuthToken, handleVaultError } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { getAccountId } from './util'
import { syncDB } from './db'
import { reportDecryptionFailure } from './syncHealthCoordinator'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  receiveAutomergeSyncMessage,
  writeAutomergeSyncCursor,
} from '../sync/automergeDocStore'
import { decryptBytesWithKey } from './vault/crypto'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

const bootstrapPromiseByScope = new Map<string, Promise<void>>()
const completedBootstrapScopes = new Set<string>()
const metadataPromiseByAccount = new Map<string, Promise<AccountMetadata>>()
const metadataHydrationPromiseByAccount = new Map<string, Promise<void>>()
const hydratedMetadataAccounts = new Set<string>()
const metadataSubscribers = new Set<() => void>()
const pendingMetadataByAccount = new Map<string, AccountMetadata>()
const metadataSyncInFlightAccounts = new Set<string>()
const metadataSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let cachedMetadata: AccountMetadata = {}
let cachedMetadataAccountId = ''
const METADATA_SYNC_RETRY_DELAY_MS = 5 * 1000
const METADATA_CACHE_STORAGE_KEY_PREFIX = 'metadata-cache'
const METADATA_PENDING_STORAGE_KEY_PREFIX = 'metadata-pending'

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

function notifyMetadataSubscribers(): void {
  for (const subscriber of metadataSubscribers) {
    subscriber()
  }
}

function getMetadataCacheStorageKey(accountId: string): string {
  return `${METADATA_CACHE_STORAGE_KEY_PREFIX}_${accountId}`
}

function getPendingMetadataStorageKey(accountId: string): string {
  return `${METADATA_PENDING_STORAGE_KEY_PREFIX}_${accountId}`
}

function isMetadataLike(value: unknown): value is AccountMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function setCachedMetadataSnapshot(metadata: AccountMetadata, accountId: string): void {
  cachedMetadata = metadata || {}
  cachedMetadataAccountId = accountId
  notifyMetadataSubscribers()
}

function clearMetadataSyncRetry(accountId: string): void {
  const timer = metadataSyncRetryTimers.get(accountId)
  if (!timer) {
    return
  }

  clearTimeout(timer)
  metadataSyncRetryTimers.delete(accountId)
}

async function hydrateMetadataState(accountId: string): Promise<void> {
  if (hydratedMetadataAccounts.has(accountId)) {
    return
  }

  const inFlight = metadataHydrationPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const hydration = Promise.all([
    syncDB.getItem<unknown>(getMetadataCacheStorageKey(accountId)),
    syncDB.getItem<unknown>(getPendingMetadataStorageKey(accountId)),
  ]).then(([storedMetadata, pendingMetadata]) => {
    if (isMetadataLike(storedMetadata)) {
      setCachedMetadataSnapshot(storedMetadata, accountId)
    }

    if (isMetadataLike(pendingMetadata)) {
      pendingMetadataByAccount.set(accountId, pendingMetadata)
      setCachedMetadataSnapshot(pendingMetadata, accountId)
    }

    hydratedMetadataAccounts.add(accountId)
  }).finally(() => {
    metadataHydrationPromiseByAccount.delete(accountId)
  })

  metadataHydrationPromiseByAccount.set(accountId, hydration)
  return hydration
}

async function flushPendingMetadataSync(accountId: string): Promise<void> {
  await hydrateMetadataState(accountId)

  if (!hasApiAuthToken() || metadataSyncInFlightAccounts.has(accountId)) {
    return
  }

  const pendingMetadata = pendingMetadataByAccount.get(accountId)
  if (!pendingMetadata) {
    clearMetadataSyncRetry(accountId)
    return
  }

  metadataSyncInFlightAccounts.add(accountId)

  try {
    await pushMetadata(pendingMetadata as Record<string, unknown>)

    if (pendingMetadataByAccount.get(accountId) === pendingMetadata) {
      pendingMetadataByAccount.delete(accountId)
      await syncDB.removeItem(getPendingMetadataStorageKey(accountId))
    }

    clearMetadataSyncRetry(accountId)
  } catch (_) {
    if (!metadataSyncRetryTimers.has(accountId)) {
      metadataSyncRetryTimers.set(accountId, setTimeout(() => {
        metadataSyncRetryTimers.delete(accountId)
        void flushPendingMetadataSync(accountId)
      }, METADATA_SYNC_RETRY_DELAY_MS))
    }
  } finally {
    metadataSyncInFlightAccounts.delete(accountId)

    if (pendingMetadataByAccount.has(accountId) && hasApiAuthToken()) {
      void flushPendingMetadataSync(accountId)
    }
  }
}

function normalizeMetadataFromServer(payload: unknown): AccountMetadata {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {}
  }

  const record = payload as Record<string, unknown>
  if (
    typeof record.cipher === 'string'
    || typeof record.iv === 'string'
    || Array.isArray(record.branches)
  ) {
    return {}
  }

  return record as AccountMetadata
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
  const hadSnapshot = Object.keys(cachedMetadata).length > 0 || cachedMetadataAccountId.length > 0

  const accountsToClear = new Set<string>()
  if (cachedMetadataAccountId) {
    accountsToClear.add(cachedMetadataAccountId)
  }
  for (const accountId of pendingMetadataByAccount.keys()) {
    accountsToClear.add(accountId)
  }

  for (const accountId of accountsToClear) {
    void syncDB.removeItem(getMetadataCacheStorageKey(accountId))
    void syncDB.removeItem(getPendingMetadataStorageKey(accountId))
    hydratedMetadataAccounts.delete(accountId)
    metadataHydrationPromiseByAccount.delete(accountId)
  }

  cachedMetadata = {}
  cachedMetadataAccountId = ''
  metadataPromiseByAccount.clear()
  pendingMetadataByAccount.clear()
  metadataSyncInFlightAccounts.clear()

  for (const accountId of metadataSyncRetryTimers.keys()) {
    clearMetadataSyncRetry(accountId)
  }

  if (hadSnapshot) {
    notifyMetadataSubscribers()
  }
}

export function setCachedMetadata(metadata: AccountMetadata): void {
  const accountId = getAccountId()
  setCachedMetadataSnapshot(metadata || {}, accountId)
  void syncDB.setItem(getMetadataCacheStorageKey(accountId), metadata || {})
}

export function queueMetadataForSync(
  metadata: AccountMetadata,
  accountId = getAccountId(),
): void {
  pendingMetadataByAccount.set(accountId, metadata || {})
  void syncDB.setItem(getPendingMetadataStorageKey(accountId), metadata || {})
  void syncDB.setItem(getMetadataCacheStorageKey(accountId), metadata || {})
  void flushPendingMetadataSync(accountId)
}

export function requestMetadataSync(accountId = getAccountId()): void {
  void flushPendingMetadataSync(accountId)
}

export async function ensureMetadataLoaded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  await hydrateMetadataState(accountId)

  if (!hasApiAuthToken()) {
    return cachedMetadataAccountId === accountId ? cachedMetadata : {}
  }

  if (pendingMetadataByAccount.has(accountId) && cachedMetadataAccountId === accountId) {
    return cachedMetadata
  }

  if (!options.force && cachedMetadataAccountId === accountId) {
    return cachedMetadata
  }

  const inFlight = metadataPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const loadPromise = fetchMetadata(accountId)
    .catch(error => {
      handleVaultError(error, 'Failed to fetch metadata')
      return cachedMetadataAccountId === accountId ? cachedMetadata : {}
    })
    .finally(() => {
      metadataPromiseByAccount.delete(accountId)
    })

  metadataPromiseByAccount.set(accountId, loadPromise)
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
    return { items: [] as VaultItem[], serverTime: 0 }
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

export async function fetchItems(options: FetchItemsOptions = {}): Promise<Item[]> {
  const accountId = getAccountId()
  if (options.forceMetadataRefetch && hasApiAuthToken()) {
    await ensureMetadataLoaded(accountId, { force: true })
  }

  await ensureItemsBootstrap(accountId, {
    force: options.forceFullSync,
  })
  const visibleItems = getAutomergeItems()

  return sortItems(visibleItems, DEFAULT_CRITERIA)
}

export function ensureItemsBootstrap(accountId: string, options: EnsureItemsBootstrapOptions = {}): Promise<void> {
  return initializeAutomergeDocStore(accountId)
    .then(() => {
      const scopeKey = getBootstrapScopeKey(accountId)
      const forced = !!(options.force || options.forceFullSync)

      if (!hasApiAuthToken()) {
        return
      }

      if (!forced && completedBootstrapScopes.has(scopeKey)) {
        return
      }

      const inFlight = bootstrapPromiseByScope.get(scopeKey)
      if (inFlight) {
        return
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
      void bootstrap
    })
}

export async function fetchMetadata(accountId = getAccountId()): Promise<AccountMetadata> {
  await hydrateMetadataState(accountId)

  if (!hasApiAuthToken()) {
    return cachedMetadataAccountId === accountId ? cachedMetadata : {}
  }

  const result = await getMetadata()
  const metadata = normalizeMetadataFromServer(result)

  setCachedMetadataSnapshot(metadata, accountId)
  void syncDB.setItem(getMetadataCacheStorageKey(accountId), metadata)
  return metadata
}

export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}

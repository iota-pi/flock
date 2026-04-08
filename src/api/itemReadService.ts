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

export async function fetchMetadata(accountId = getAccountId()): Promise<AccountMetadata> {
  const result = await getMetadata()
  const scopeKey = getMetadataScopeKey(accountId)
  const metadata = normalizeMetadataFromServer(result)

  setCachedMetadataSnapshot(metadata, scopeKey)
  return metadata
}

export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}

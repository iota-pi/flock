import { fetchMany, type VaultItem } from './vault/client'
import { trpcClient } from './trpcClient'
import * as vault from './vault'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { getApiAuthToken, hasApiAuthToken, handleVaultError } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { getAccountId } from './util'
import { syncDB } from './db'
import { reportDecryptionFailure } from './syncHealthCoordinator'
import {
  ACCOUNT_METADATA_DOCUMENT_ID,
  getAutomergeItems,
  getAutomergeMetadata,
  hasAutomergeDocument,
  initializeAutomergeDocStore,
  receiveAutomergeSyncMessage,
  subscribeAutomergeMetadata,
  upsertAutomergeMetadataSnapshot,
  writeAutomergeSyncCursor,
} from '../sync/automergeDocStore'
import { decryptBytesWithKey } from './vault/crypto'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

const bootstrapPromiseByScope = new Map<string, Promise<void>>()
const completedBootstrapScopes = new Set<string>()
const metadataPromiseByAccount = new Map<string, Promise<AccountMetadata>>()
const metadataMigrationHydrationPromiseByAccount = new Map<string, Promise<void>>()
const metadataMigrationCompleteByAccount = new Map<string, boolean>()
const knownMetadataAccounts = new Set<string>()
const METADATA_MIGRATION_STORAGE_KEY_PREFIX = 'metadata-automerge-migrated'

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

function getMetadataMigrationStorageKey(accountId: string): string {
  return `${METADATA_MIGRATION_STORAGE_KEY_PREFIX}_${accountId}`
}

function isMetadataLike(value: unknown): value is AccountMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isMetadataEmpty(metadata: AccountMetadata): boolean {
  return Object.keys(metadata || {}).length === 0
}

async function hydrateMetadataMigrationState(accountId: string): Promise<void> {
  knownMetadataAccounts.add(accountId)

  if (metadataMigrationCompleteByAccount.has(accountId)) {
    return
  }

  const inFlight = metadataMigrationHydrationPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const hydration = syncDB.getItem<unknown>(getMetadataMigrationStorageKey(accountId))
    .then(value => {
      metadataMigrationCompleteByAccount.set(accountId, value === true)
    })
    .finally(() => {
      metadataMigrationHydrationPromiseByAccount.delete(accountId)
    })

  metadataMigrationHydrationPromiseByAccount.set(accountId, hydration)
  return hydration
}

async function markMetadataMigrationComplete(accountId: string): Promise<void> {
  metadataMigrationCompleteByAccount.set(accountId, true)
  knownMetadataAccounts.add(accountId)
  await syncDB.setItem(getMetadataMigrationStorageKey(accountId), true)
}

function normalizeMetadataFromServer(payload: unknown): AccountMetadata {
  if (!isMetadataLike(payload)) {
    return {}
  }

  return payload
}

export function getCachedMetadata(): AccountMetadata {
  return getAutomergeMetadata()
}

export function subscribeMetadata(listener: () => void): () => void {
  return subscribeAutomergeMetadata(listener)
}

export function clearMetadataCache(): void {
  metadataPromiseByAccount.clear()
  metadataMigrationHydrationPromiseByAccount.clear()

  const accountsToClear = new Set<string>(knownMetadataAccounts)
  const activeAccount = getAccountId()
  if (activeAccount) {
    accountsToClear.add(activeAccount)
  }

  for (const accountId of accountsToClear) {
    void syncDB.removeItem(getMetadataMigrationStorageKey(accountId))
    metadataMigrationCompleteByAccount.delete(accountId)
  }

  knownMetadataAccounts.clear()
}

async function fetchLegacyMetadata(accountId: string): Promise<AccountMetadata> {
  if (!hasApiAuthToken()) {
    return getAutomergeMetadata()
  }

  const response = await trpcClient.accounts.getMetadata.query({ account: accountId })
  if (!response?.success) {
    throw new Error('Failed to fetch legacy metadata')
  }

  return normalizeMetadataFromServer(response.metadata)
}

async function migrateLegacyMetadataIfNeeded(accountId: string): Promise<AccountMetadata> {
  await initializeAutomergeDocStore(accountId)
  await hydrateMetadataMigrationState(accountId)

  const localMetadata = getAutomergeMetadata()
  const hasLocalMetadataDoc = hasAutomergeDocument(ACCOUNT_METADATA_DOCUMENT_ID)
  const migrationComplete = metadataMigrationCompleteByAccount.get(accountId) === true

  if (hasLocalMetadataDoc && (!isMetadataEmpty(localMetadata) || migrationComplete)) {
    return localMetadata
  }

  if (!hasApiAuthToken()) {
    return localMetadata
  }

  const legacyMetadata = await fetchLegacyMetadata(accountId)
  if (!isMetadataLike(legacyMetadata)) {
    return localMetadata
  }

  await upsertAutomergeMetadataSnapshot(legacyMetadata)
  await markMetadataMigrationComplete(accountId)
  requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])

  return getAutomergeMetadata()
}

export async function ensureMetadataLoaded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  knownMetadataAccounts.add(accountId)
  await initializeAutomergeDocStore(accountId)

  if (options.force) {
    requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])
  }

  const inFlight = metadataPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const loadPromise = migrateLegacyMetadataIfNeeded(accountId)
    .catch(error => {
      handleVaultError(error, 'Failed to load metadata')
      return getAutomergeMetadata()
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

  await initializeAutomergeDocStore(accountId)

  if (options.forceMetadataRefetch) {
    void ensureMetadataLoaded(accountId, { force: true })
  }

  void ensureItemsBootstrap(accountId, {
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
  return ensureMetadataLoaded(accountId, { force: true })
}

export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}

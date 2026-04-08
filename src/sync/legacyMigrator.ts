import { syncDB } from '../api/db'
import {
  getApiAuthToken,
  handleVaultError,
  hasApiAuthToken,
} from '../api/runtime'
import { reportDecryptionFailure } from '../api/syncHealthCoordinator'
import { trpcClient } from '../api/trpcClient'
import { decryptBytesWithKey } from '../api/vault/crypto'
import { fetchMany, type VaultItem } from '../api/vault/client'
import * as vault from '../api/vault'
import type { AccountMetadata } from '../state/metadata'
import {
  ACCOUNT_METADATA_DOCUMENT_ID,
  getAutomergeMetadata,
  hasAutomergeDocument,
  initializeAutomergeDocStore,
  receiveAutomergeSyncMessage,
  upsertAutomergeMetadataSnapshot,
  writeAutomergeSyncCursor,
} from './automergeDocStore'
import { requestAutomergeSync } from './automergeSyncDispatcher'
import {
  getLegacyMetadataMigrationStorageKey,
  getLegacyMigrationStorageKey,
} from './legacyMigrationStorage'

const legacyMigrationPromiseByScope = new Map<string, Promise<void>>()
const metadataMigrationHydrationPromiseByAccount = new Map<string, Promise<void>>()
const metadataMigrationCompleteByAccount = new Map<string, boolean>()
const legacyMigrationHydrationPromiseByAccount = new Map<string, Promise<void>>()
const legacyMigrationCompleteByAccount = new Map<string, boolean>()

type LegacyMigrationOptions = {
  force?: boolean
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type SyncSnapshotMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
  }
}

function getLegacyMigrationScopeKey(accountId: string): string {
  return `${accountId}:${getApiAuthToken()}`
}

function isMetadataLike(value: unknown): value is AccountMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isMetadataEmpty(metadata: AccountMetadata): boolean {
  return Object.keys(metadata || {}).length === 0
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function hydrateMetadataMigrationState(accountId: string): Promise<void> {
  if (metadataMigrationCompleteByAccount.has(accountId)) {
    return
  }

  const inFlight = metadataMigrationHydrationPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const hydration = syncDB.getItem<unknown>(getLegacyMetadataMigrationStorageKey(accountId))
    .then(value => {
      metadataMigrationCompleteByAccount.set(accountId, value === true)
    })
    .finally(() => {
      metadataMigrationHydrationPromiseByAccount.delete(accountId)
    })

  metadataMigrationHydrationPromiseByAccount.set(accountId, hydration)
  return hydration
}

async function hydrateLegacyMigrationState(accountId: string): Promise<void> {
  if (legacyMigrationCompleteByAccount.has(accountId)) {
    return
  }

  const inFlight = legacyMigrationHydrationPromiseByAccount.get(accountId)
  if (inFlight) {
    return inFlight
  }

  const hydration = syncDB.getItem<unknown>(getLegacyMigrationStorageKey(accountId))
    .then(value => {
      legacyMigrationCompleteByAccount.set(accountId, value === true)
    })
    .finally(() => {
      legacyMigrationHydrationPromiseByAccount.delete(accountId)
    })

  legacyMigrationHydrationPromiseByAccount.set(accountId, hydration)
  return hydration
}

async function markMetadataMigrationComplete(accountId: string): Promise<void> {
  metadataMigrationCompleteByAccount.set(accountId, true)
  await syncDB.setItem(getLegacyMetadataMigrationStorageKey(accountId), true)
}

async function markLegacyMigrationComplete(accountId: string): Promise<void> {
  legacyMigrationCompleteByAccount.set(accountId, true)
  await syncDB.setItem(getLegacyMigrationStorageKey(accountId), true)
}

function normalizeMetadataFromServer(payload: unknown): AccountMetadata {
  if (!isMetadataLike(payload)) {
    return {}
  }

  return payload
}

export async function fetchLegacyMetadata(accountId: string): Promise<AccountMetadata> {
  if (!hasApiAuthToken()) {
    return getAutomergeMetadata()
  }

  const response = await trpcClient.accounts.getMetadata.query({ account: accountId })
  if (!response?.success) {
    throw new Error('Failed to fetch legacy metadata')
  }

  return normalizeMetadataFromServer(response.metadata)
}

export async function migrateLegacyMetadataIfNeeded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  await initializeAutomergeDocStore(accountId)
  await hydrateMetadataMigrationState(accountId)

  const localMetadata = getAutomergeMetadata()
  const hasLocalMetadataDoc = hasAutomergeDocument(ACCOUNT_METADATA_DOCUMENT_ID)
  const migrationComplete = metadataMigrationCompleteByAccount.get(accountId) === true

  if (!options.force && hasLocalMetadataDoc && (!isMetadataEmpty(localMetadata) || migrationComplete)) {
    return localMetadata
  }

  if (!hasApiAuthToken()) {
    return localMetadata
  }

  try {
    const legacyMetadata = await fetchLegacyMetadata(accountId)
    if (!isMetadataLike(legacyMetadata)) {
      return localMetadata
    }

    await upsertAutomergeMetadataSnapshot(legacyMetadata)
    await markMetadataMigrationComplete(accountId)
    requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])
  } catch (error) {
    handleVaultError(toError(error), 'Failed to migrate legacy metadata')
  }

  return getAutomergeMetadata()
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

export async function bootstrapItemsFromSyncMessages(accountId: string): Promise<void> {
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

export async function runLegacyMigration(accountId: string, options: LegacyMigrationOptions = {}): Promise<void> {
  await initializeAutomergeDocStore(accountId)
  await hydrateLegacyMigrationState(accountId)

  const forced = !!(options.force || options.forceFullSync || options.forceMetadataRefetch)
  const migrationComplete = legacyMigrationCompleteByAccount.get(accountId) === true

  if (!forced && migrationComplete) {
    return
  }

  const scopeKey = getLegacyMigrationScopeKey(accountId)
  const inFlight = legacyMigrationPromiseByScope.get(scopeKey)
  if (inFlight) {
    return inFlight
  }

  const migration = (async () => {
    if (!hasApiAuthToken()) {
      return
    }

    await bootstrapItemsFromSyncMessages(accountId)
    await migrateLegacyMetadataIfNeeded(accountId, { force: options.forceMetadataRefetch === true })
    await markLegacyMigrationComplete(accountId)
  })()
    .catch(error => {
      handleVaultError(toError(error), 'Failed to run legacy migration')
    })
    .finally(() => {
      legacyMigrationPromiseByScope.delete(scopeKey)
    })

  legacyMigrationPromiseByScope.set(scopeKey, migration)
  return migration
}

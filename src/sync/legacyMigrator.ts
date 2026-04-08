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

type MigrationPhase = 'idle' | 'hydrating' | 'running' | 'completed' | 'failed'

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

class MigrationManager {
  private metadataPhaseByAccount = new Map<string, MigrationPhase>()
  private metadataHydrationPromiseByAccount = new Map<string, Promise<void>>()

  private legacyPhaseByAccount = new Map<string, MigrationPhase>()
  private legacyHydrationPromiseByAccount = new Map<string, Promise<void>>()

  private migrationPromiseByScope = new Map<string, Promise<void>>()

  getMetadataPhase(accountId: string): MigrationPhase {
    return this.metadataPhaseByAccount.get(accountId) || 'idle'
  }

  getLegacyPhase(accountId: string): MigrationPhase {
    return this.legacyPhaseByAccount.get(accountId) || 'idle'
  }

  setMetadataPhase(accountId: string, phase: MigrationPhase): void {
    this.metadataPhaseByAccount.set(accountId, phase)
  }

  setLegacyPhase(accountId: string, phase: MigrationPhase): void {
    this.legacyPhaseByAccount.set(accountId, phase)
  }

  getScopedPromise(scopeKey: string): Promise<void> | undefined {
    return this.migrationPromiseByScope.get(scopeKey)
  }

  setScopedPromise(scopeKey: string, promise: Promise<void>): void {
    this.migrationPromiseByScope.set(scopeKey, promise)
  }

  clearScopedPromise(scopeKey: string): void {
    this.migrationPromiseByScope.delete(scopeKey)
  }

  async hydrateMetadataState(accountId: string): Promise<void> {
    const phase = this.getMetadataPhase(accountId)
    if (phase === 'completed') {
      return
    }

    const inFlight = this.metadataHydrationPromiseByAccount.get(accountId)
    if (inFlight) {
      return inFlight
    }

    this.setMetadataPhase(accountId, 'hydrating')

    const hydration = syncDB.getItem<unknown>(getLegacyMetadataMigrationStorageKey(accountId))
      .then(value => {
        this.setMetadataPhase(accountId, value === true ? 'completed' : 'idle')
      })
      .catch(() => {
        this.setMetadataPhase(accountId, 'failed')
      })
      .finally(() => {
        this.metadataHydrationPromiseByAccount.delete(accountId)
      })

    this.metadataHydrationPromiseByAccount.set(accountId, hydration)
    return hydration
  }

  async hydrateLegacyState(accountId: string): Promise<void> {
    const phase = this.getLegacyPhase(accountId)
    if (phase === 'completed') {
      return
    }

    const inFlight = this.legacyHydrationPromiseByAccount.get(accountId)
    if (inFlight) {
      return inFlight
    }

    this.setLegacyPhase(accountId, 'hydrating')

    const hydration = syncDB.getItem<unknown>(getLegacyMigrationStorageKey(accountId))
      .then(value => {
        this.setLegacyPhase(accountId, value === true ? 'completed' : 'idle')
      })
      .catch(() => {
        this.setLegacyPhase(accountId, 'failed')
      })
      .finally(() => {
        this.legacyHydrationPromiseByAccount.delete(accountId)
      })

    this.legacyHydrationPromiseByAccount.set(accountId, hydration)
    return hydration
  }

  async markMetadataComplete(accountId: string): Promise<void> {
    this.setMetadataPhase(accountId, 'completed')
    await syncDB.setItem(getLegacyMetadataMigrationStorageKey(accountId), true)
  }

  async markLegacyComplete(accountId: string): Promise<void> {
    this.setLegacyPhase(accountId, 'completed')
    await syncDB.setItem(getLegacyMigrationStorageKey(accountId), true)
  }
}

const migrationManager = new MigrationManager()

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
  await migrationManager.hydrateMetadataState(accountId)
}

function isMetadataMigrationComplete(accountId: string): boolean {
  return migrationManager.getMetadataPhase(accountId) === 'completed'
}

function isLegacyMigrationComplete(accountId: string): boolean {
  return migrationManager.getLegacyPhase(accountId) === 'completed'
}

function markLegacyMigrationRunning(accountId: string): void {
  migrationManager.setLegacyPhase(accountId, 'running')
}

function markLegacyMigrationFailed(accountId: string): void {
  migrationManager.setLegacyPhase(accountId, 'failed')
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
  const migrationComplete = isMetadataMigrationComplete(accountId)

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
    await migrationManager.markMetadataComplete(accountId)
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
  await migrationManager.hydrateLegacyState(accountId)

  const forced = !!(options.force || options.forceFullSync || options.forceMetadataRefetch)
  if (!forced && isLegacyMigrationComplete(accountId)) {
    return
  }

  const scopeKey = getLegacyMigrationScopeKey(accountId)
  const inFlight = migrationManager.getScopedPromise(scopeKey)
  if (inFlight) {
    return inFlight
  }

  markLegacyMigrationRunning(accountId)

  const migration = (async () => {
    if (!hasApiAuthToken()) {
      return
    }

    await bootstrapItemsFromSyncMessages(accountId)
    await migrateLegacyMetadataIfNeeded(accountId, { force: options.forceMetadataRefetch === true })
    await migrationManager.markLegacyComplete(accountId)
  })()
    .catch(error => {
      markLegacyMigrationFailed(accountId)
      handleVaultError(toError(error), 'Failed to run legacy migration')
    })
    .finally(() => {
      migrationManager.clearScopedPromise(scopeKey)
    })

  migrationManager.setScopedPromise(scopeKey, migration)
  return migration
}

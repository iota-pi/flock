import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { syncDB } from './db'
import { getAccountId } from './util'
import {
  ACCOUNT_METADATA_DOCUMENT_ID,
  getAutomergeItems,
  getAutomergeMetadata,
  initializeAutomergeDocStore,
  listAutomergeDocumentIds,
  subscribeAutomergeMetadata,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { getLegacyMigrationStorageKey } from '../sync/legacyMigrationStorage'

type FetchItemsOptions = {
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type EnsureItemsBootstrapOptions = FetchItemsOptions & {
  force?: boolean
}

function shouldForceLegacyMigrator(options: EnsureItemsBootstrapOptions): boolean {
  return !!(options.force || options.forceFullSync || options.forceMetadataRefetch)
}

async function shouldLazyLoadLegacyMigrator(
  accountId: string,
  options: EnsureItemsBootstrapOptions,
): Promise<boolean> {
  if (shouldForceLegacyMigrator(options)) {
    return true
  }

  const knownDocumentIds = listAutomergeDocumentIds()
  if (knownDocumentIds.length === 0) {
    return true
  }

  const migrated = await syncDB.getItem<unknown>(getLegacyMigrationStorageKey(accountId))
  return migrated !== true
}

function requestSyncForKnownDocuments(): void {
  const knownDocumentIds = listAutomergeDocumentIds()
  if (knownDocumentIds.length === 0) {
    return
  }

  requestAutomergeSync(knownDocumentIds)
}

export function getCachedMetadata(): AccountMetadata {
  return getAutomergeMetadata()
}

export function subscribeMetadata(listener: () => void): () => void {
  return subscribeAutomergeMetadata(listener)
}

export function clearMetadataCache(): void {
  // Compatibility no-op: metadata is read directly from local Automerge snapshots.
}

export async function ensureMetadataLoaded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  await initializeAutomergeDocStore(accountId)

  await ensureItemsBootstrap(accountId, {
    force: options.force,
    forceMetadataRefetch: options.force,
  })

  return getAutomergeMetadata()
}

export async function ensureItemsBootstrap(
  accountId: string,
  options: EnsureItemsBootstrapOptions = {},
): Promise<void> {
  await initializeAutomergeDocStore(accountId)

  if (await shouldLazyLoadLegacyMigrator(accountId, options)) {
    const { runLegacyMigration } = await import('../sync/legacyMigrator')
    await runLegacyMigration(accountId, options)
  }

  requestSyncForKnownDocuments()

  if (options.forceMetadataRefetch) {
    requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])
  }
}

export async function fetchItems(options: FetchItemsOptions = {}): Promise<Item[]> {
  const accountId = getAccountId()

  await initializeAutomergeDocStore(accountId)

  void ensureItemsBootstrap(accountId, {
    force: options.forceFullSync,
    forceFullSync: options.forceFullSync,
    forceMetadataRefetch: options.forceMetadataRefetch,
  })

  return sortItems(getAutomergeItems(), DEFAULT_CRITERIA)
}

export async function fetchMetadata(accountId = getAccountId()): Promise<AccountMetadata> {
  await initializeAutomergeDocStore(accountId)
  void ensureItemsBootstrap(accountId)
  return getAutomergeMetadata()
}

export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}

import {
  Repo,
  type StorageAdapterInterface,
  type Chunk,
  type DocHandle,
  type DocumentId,
} from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'

import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { runStorageOperation } from '../utils/storageManager'
import type { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import { getVaultStorageNames } from '../shared/storageNames'
import type { KeyProvider } from '../keys/Keyring'
import type { RealtimeBus } from './RealtimeBus'
import { createLogger } from '../utils/logger'
import { DocChangeListeners } from './DocChangeListeners'

const log = createLogger('AutomergeRepoManager')

export interface AutomergeStorageAdapter extends StorageAdapterInterface {
  has(key: string[]): Promise<boolean>
}

class QuotaHandlingStorageAdapter implements AutomergeStorageAdapter {
  private isFlushed = false

  constructor(private delegate: AutomergeStorageAdapter) {}

  /**
   * Marks the Repo as shut down. `Repo.shutdown` saves every loaded doc, but leaves the throttled
   * saves that edits and sync states queued, which run up to `saveDebounceRate` later, once the
   * database has closed. Nothing handles their errors, so each would be an unhandled rejection.
   * They're dropped instead: the shutdown already saved those docs whole, and a sync state only
   * saves a peer some round trips.
   */
  markFlushed(): void {
    this.isFlushed = true
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return runStorageOperation(() => this.delegate.load(key))
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
    if (this.isFlushed) return
    return runStorageOperation(() => this.delegate.save(key, data))
  }

  async remove(key: string[]): Promise<void> {
    return runStorageOperation(() => this.delegate.remove(key))
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    return runStorageOperation(() => this.delegate.loadRange(keyPrefix))
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    return runStorageOperation(() => this.delegate.removeRange(keyPrefix))
  }

  async has(key: string[]): Promise<boolean> {
    return runStorageOperation(() => this.delegate.has(key))
  }
}

export interface AutomergeRepoManagerOptions {
  onKeyVersionMissing?: (kver: string) => void
  onDocumentReceived?: (documentId: DocumentId) => void
  /**
   * Called when the doc of any item the Repo holds changes, whatever changed it: an edit in this tab,
   * a change another tab sent, or one pulled from the server. Never called for the index document.
   */
  onDocChanged?: (itemId: ItemId) => void
  /** Tells the account's other tabs which items this tab sent them */
  bus?: RealtimeBus
  /** How long the Repo waits after a doc changes to save it (Automerge's default otherwise) */
  saveDebounceRate?: number
}

/** Owns the account's Repo and the storage it's built on, which it closes on stop */
export class AutomergeRepoManager {
  readonly repo: Repo
  /** The Repo's storage, with quota failures handled */
  readonly storage: AutomergeStorageAdapter
  private readonly quotaStorage: QuotaHandlingStorageAdapter
  private readonly broadcastAdapter: EncryptedBroadcastChannelNetworkAdapter
  private readonly changeListeners: DocChangeListeners
  private isClosed = false

  constructor(
    private readonly accountId: string,
    keys: KeyProvider,
    private readonly indexedDbAdapter: VaultIndexedDBStorageAdapter,
    options?: AutomergeRepoManagerOptions,
  ) {
    this.quotaStorage = new QuotaHandlingStorageAdapter(indexedDbAdapter)
    this.storage = this.quotaStorage

    this.broadcastAdapter = new EncryptedBroadcastChannelNetworkAdapter({
      channelName: `${getVaultStorageNames().accountPrefixes.automergeBroadcastChannel}${accountId}`,
      bus: options?.bus,
      keys,
      onKeyVersionMissing: options?.onKeyVersionMissing,
      onDocumentReceived: documentId => {
        this.changeListeners.watchReceivedDocument(documentId)
        options?.onDocumentReceived?.(documentId)
      },
    })

    this.repo = new Repo({
      storage: this.storage,
      network: [this.broadcastAdapter],
      saveDebounceRate: options?.saveDebounceRate,
    })
    this.changeListeners = new DocChangeListeners(this.repo, itemId => options?.onDocChanged?.(itemId))
  }

  /** Listens for changes to the handle, whatever doc store path found or created it */
  watchHandle(handle: DocHandle<unknown>): void {
    this.changeListeners.watchHandle(handle)
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true
    this.changeListeners.clear()

    try {
      this.broadcastAdapter.disconnect()
    } catch (err) {
      log.error(`Error disconnecting broadcast adapter for ${this.accountId}:`, err)
    }

    try {
      await this.repo.shutdown()
    } catch (err) {
      log.error(`Error shutting down repo for ${this.accountId}:`, err)
    }
    this.quotaStorage.markFlushed()

    // Note: Do not clear storage through the adapter on close. Database deletion
    // during logout is handled by the main thread (deleteDatabase in clearAccountLocalData)
    // after the worker has cleanly closed its open connections. Calling indexedDbAdapter.clear()
    // via an open connection creates versionchange conflicts and blocks deleteDatabase.
    try {
      await this.indexedDbAdapter.close()
    } catch (err) {
      log.error(`Error closing IndexedDB connection for ${this.accountId}:`, err)
    }
  }
}

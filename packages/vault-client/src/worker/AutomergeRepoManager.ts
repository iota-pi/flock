import {
  Repo,
  type StorageAdapterInterface,
  type Chunk,
} from '@automerge/automerge-repo/slim'

import { runStorageOperation } from '../utils/storageManager'
import type { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import { createLogger } from '../utils/logger'

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
  /** How long the Repo waits after a doc changes to save it (Automerge's default otherwise) */
  saveDebounceRate?: number
}

/**
 * Owns the account's Repo and the storage it's built on, which it closes on stop. The Repo has no
 * network: only the active tab's engine runs, and it reaches the server through the sync log.
 */
export class AutomergeRepoManager {
  readonly repo: Repo
  /** The Repo's storage, with quota failures handled */
  readonly storage: AutomergeStorageAdapter
  private readonly quotaStorage: QuotaHandlingStorageAdapter
  private isClosed = false

  constructor(
    private readonly accountId: string,
    private readonly indexedDbAdapter: VaultIndexedDBStorageAdapter,
    options?: AutomergeRepoManagerOptions,
  ) {
    this.quotaStorage = new QuotaHandlingStorageAdapter(indexedDbAdapter)
    this.storage = this.quotaStorage

    this.repo = new Repo({
      storage: this.storage,
      network: [],
      saveDebounceRate: options?.saveDebounceRate,
    })
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true

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

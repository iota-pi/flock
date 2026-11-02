import { Repo, type StorageAdapterInterface, type Chunk, type DocumentId } from '@automerge/automerge-repo/slim'

import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { runStorageOperation } from '../utils/storageManager'
import type { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import { getVaultStorageNames } from '../shared/storageNames'
import type { KeyProvider } from '../keys/Keyring'
import type { RealtimeBus } from './RealtimeBus'
import { createLogger } from '../utils/logger'

const log = createLogger('AutomergeRepoManager')

export interface AutomergeStorageAdapter extends StorageAdapterInterface {
  has(key: string[]): Promise<boolean>
}

class QuotaHandlingStorageAdapter implements AutomergeStorageAdapter {
  constructor(private delegate: AutomergeStorageAdapter) {}

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return runStorageOperation(() => this.delegate.load(key))
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
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

export function getAutomergeDBName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.automergeDatabase}${accountId}`
}

export interface AutomergeRepoManagerOptions {
  onKeyVersionMissing?: (kver: string) => void
  onDocumentReceived?: (documentId: DocumentId) => void
  /** Tells the account's other tabs which items this tab sent them */
  bus?: RealtimeBus
}

/** Owns the account's Repo and the storage it's built on, which it closes on stop */
export class AutomergeRepoManager {
  readonly repo: Repo
  /** The Repo's storage, with quota failures handled */
  readonly storage: AutomergeStorageAdapter
  private readonly broadcastAdapter: EncryptedBroadcastChannelNetworkAdapter
  private isClosed = false

  constructor(
    private readonly accountId: string,
    keys: KeyProvider,
    vaultNetworkAdapter: VaultNetworkAdapter,
    private readonly indexedDbAdapter: VaultIndexedDBStorageAdapter,
    options?: AutomergeRepoManagerOptions,
  ) {
    this.storage = new QuotaHandlingStorageAdapter(indexedDbAdapter)

    this.broadcastAdapter = new EncryptedBroadcastChannelNetworkAdapter({
      channelName: `${getVaultStorageNames().accountPrefixes.automergeBroadcastChannel}${accountId}`,
      bus: options?.bus,
      keys,
      onKeyVersionMissing: options?.onKeyVersionMissing,
      onDocumentReceived: options?.onDocumentReceived,
    })

    this.repo = new Repo({
      storage: this.storage,
      network: [
        this.broadcastAdapter,
        vaultNetworkAdapter,
      ],
    })
  }

  pauseBroadcastSync(): void {
    this.broadcastAdapter.pause()
  }

  resumeBroadcastSync(): void {
    this.broadcastAdapter.resume()
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true

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

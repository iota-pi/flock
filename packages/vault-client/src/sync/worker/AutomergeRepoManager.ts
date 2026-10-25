import { Repo, type StorageAdapterInterface, type Chunk, type DocumentId } from '@automerge/automerge-repo/slim'

import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { runStorageOperation } from '../utils/storageManager'
import { isQuotaError } from '../utils/storageQuota'
import type { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { getVaultStorageNames } from '../shared/storageNames'
import type { KeyProvider } from '../../api/Keyring'
import { createLogger } from '../utils/logger'

const log = createLogger('AutomergeRepoManager')

export interface AutomergeStorageAdapter extends StorageAdapterInterface {
  has(key: string[]): Promise<boolean>
}

class QuotaHandlingStorageAdapter implements AutomergeStorageAdapter {
  constructor(
    private delegate: AutomergeStorageAdapter,
    private onQuotaError?: (error: unknown) => void
  ) {}

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return runStorageOperation(() => this.delegate.load(key))
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
    try {
      return await runStorageOperation(() => this.delegate.save(key, data))
    } catch (error) {
      if (isQuotaError(error)) {
        this.onQuotaError?.(error)
      }
      throw error
    }
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
  onQuotaError?: (error: unknown) => void
}

export class AutomergeRepoManager implements LifecycleAware<{ clearLocalData?: boolean }> {
  readonly lifecycleName = 'RepoManager'
  private repo: Repo | null = null
  private indexedDbAdapter: VaultIndexedDBStorageAdapter | null = null
  private quotaAdapter: QuotaHandlingStorageAdapter | null = null
  private broadcastAdapter: EncryptedBroadcastChannelNetworkAdapter | null = null

  constructor(
    private readonly accountId: string,
    private readonly keys: KeyProvider,
  ) {}

  async onLifecycleStop(_?: { clearLocalData?: boolean }): Promise<void> {
    await this.close()
  }

  /** Creates the Repo on `storage`, which this manager then owns and closes on stop */
  init(
    vaultNetworkAdapter: VaultNetworkAdapter,
    storage: VaultIndexedDBStorageAdapter,
    options?: AutomergeRepoManagerOptions,
  ): Repo {
    if (this.repo) {
      throw new Error(`Automerge repo for account ${this.accountId} has already been initialized`)
    }

    this.indexedDbAdapter = storage
    this.quotaAdapter = new QuotaHandlingStorageAdapter(this.indexedDbAdapter, options?.onQuotaError)

    this.broadcastAdapter = new EncryptedBroadcastChannelNetworkAdapter({
      channelName: `${getVaultStorageNames().accountPrefixes.automergeBroadcastChannel}${this.accountId}`,
      accountId: this.accountId,
      keys: this.keys,
      onKeyVersionMissing: options?.onKeyVersionMissing,
      onDocumentReceived: options?.onDocumentReceived,
    })

    this.repo = new Repo({
      storage: this.quotaAdapter,
      network: [
        this.broadcastAdapter,
        vaultNetworkAdapter,
      ],
    })

    return this.repo
  }

  getStorage(): AutomergeStorageAdapter | null {
    return this.quotaAdapter
  }

  pauseBroadcastSync(): void {
    if (this.broadcastAdapter) {
      this.broadcastAdapter.pause()
    }
  }

  resumeBroadcastSync(): void {
    if (this.broadcastAdapter) {
      this.broadcastAdapter.resume()
    }
  }

  async close(): Promise<void> {
    if (this.broadcastAdapter) {
      try {
        this.broadcastAdapter.disconnect()
      } catch (err) {
        log.error(`Error disconnecting broadcast adapter for ${this.accountId}:`, err)
      }
      this.broadcastAdapter = null
    }

    if (this.repo) {
      try {
        await this.repo.shutdown()
      } catch (err) {
        log.error(`Error shutting down repo for ${this.accountId}:`, err)
      }
      this.repo = null
    }

    // Note: Do not clear storage through the adapter on close. Database deletion
    // during logout is handled by the main thread (deleteDatabase in clearAccountLocalData)
    // after the worker has cleanly closed its open connections. Calling indexedDbAdapter.clear()
    // via an open connection creates versionchange conflicts and blocks deleteDatabase.
    if (this.indexedDbAdapter) {
      try {
        await this.indexedDbAdapter.close()
      } catch (err) {
        log.error(`Error closing IndexedDB connection for ${this.accountId}:`, err)
      }
      this.indexedDbAdapter = null
    }
  }
}

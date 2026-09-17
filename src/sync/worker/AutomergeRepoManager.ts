import { Repo, type StorageAdapterInterface, type Chunk, type DocumentId } from '@automerge/automerge-repo/slim'
import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { runStorageOperation } from '../../utils/storageManager'
import { isQuotaError } from '../../utils/storageQuota'
import { FlockIndexedDBStorageAdapter } from './FlockIndexedDBStorageAdapter'

class QuotaHandlingStorageAdapter implements StorageAdapterInterface {
  constructor(
    private delegate: StorageAdapterInterface,
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
}

export function getAutomergeDBName(accountId: string): string {
  return `flock-automerge-db-${accountId}`
}

export interface AutomergeRepoManagerOptions {
  onKeyVersionMissing?: (kver: string) => void
  onDocumentReceived?: (documentId: DocumentId) => void
  onQuotaError?: (error: unknown) => void
}

export class AutomergeRepoManager {
  private repo: Repo | null = null
  private indexedDbAdapter: FlockIndexedDBStorageAdapter | null = null
  private broadcastAdapter: EncryptedBroadcastChannelNetworkAdapter | null = null

  constructor(private readonly accountId: string) {}

  init(vaultNetworkAdapter: VaultNetworkAdapter, options?: AutomergeRepoManagerOptions): Repo {
    if (this.repo) {
      throw new Error(`Automerge repo for account ${this.accountId} has already been initialized`)
    }

    const dbName = getAutomergeDBName(this.accountId)
    this.indexedDbAdapter = new FlockIndexedDBStorageAdapter(dbName)

    this.broadcastAdapter = new EncryptedBroadcastChannelNetworkAdapter({
      channelName: `flock-automerge-broadcast-${this.accountId}`,
      onKeyVersionMissing: options?.onKeyVersionMissing,
      onDocumentReceived: options?.onDocumentReceived,
    })

    this.repo = new Repo({
      storage: new QuotaHandlingStorageAdapter(this.indexedDbAdapter, options?.onQuotaError),
      network: [
        this.broadcastAdapter,
        vaultNetworkAdapter,
      ],
    })

    return this.repo
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

  isBroadcastSyncPaused(): boolean {
    return this.broadcastAdapter?.isSyncPaused() ?? false
  }

  getRepo(): Repo {
    if (!this.repo) {
      throw new Error(`Automerge repo for account ${this.accountId} has not been initialized`)
    }
    return this.repo
  }

  async clearLocalData(): Promise<void> {
    if (this.indexedDbAdapter) {
      await runStorageOperation(() => this.indexedDbAdapter!.clear())
    }
  }

  async close(): Promise<void> {
    if (this.broadcastAdapter) {
      try {
        this.broadcastAdapter.disconnect()
      } catch (err) {
        console.error(`[AutomergeRepoManager] Error disconnecting broadcast adapter for ${this.accountId}:`, err)
      }
      this.broadcastAdapter = null
    }

    if (this.repo) {
      try {
        await this.repo.shutdown()
      } catch (err) {
        console.error(`[AutomergeRepoManager] Error shutting down repo for ${this.accountId}:`, err)
      }
      this.repo = null
    }

    if (this.indexedDbAdapter) {
      try {
        this.indexedDbAdapter.close()
      } catch (err) {
        console.error(`[AutomergeRepoManager] Error closing IndexedDB connection for ${this.accountId}:`, err)
      }
      this.indexedDbAdapter = null
    }
  }
}

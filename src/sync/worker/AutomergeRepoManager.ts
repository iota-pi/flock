import { Repo, type StorageAdapterInterface, type Chunk } from '@automerge/automerge-repo/slim'
import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { runStorageOperation } from '../../utils/storageManager'
import { FlockIndexedDBStorageAdapter } from './FlockIndexedDBStorageAdapter'

class QuotaHandlingStorageAdapter implements StorageAdapterInterface {
  constructor(private delegate: StorageAdapterInterface) {}

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
}

export function getAutomergeDBName(accountId: string): string {
  return `flock-automerge-db-${accountId}`
}

export class AutomergeRepoManager {
  private repo: Repo | null = null
  private indexedDbAdapter: FlockIndexedDBStorageAdapter | null = null

  constructor(private readonly accountId: string) {}

  init(vaultNetworkAdapter: VaultNetworkAdapter): Repo {
    if (this.repo) {
      throw new Error(`Automerge repo for account ${this.accountId} has already been initialized`)
    }

    const dbName = getAutomergeDBName(this.accountId)
    this.indexedDbAdapter = new FlockIndexedDBStorageAdapter(dbName)

    this.repo = new Repo({
      storage: new QuotaHandlingStorageAdapter(this.indexedDbAdapter),
      network: [
        new EncryptedBroadcastChannelNetworkAdapter({
          channelName: `flock-automerge-broadcast-${this.accountId}`,
        }),
        vaultNetworkAdapter,
      ],
    })

    return this.repo
  }

  getRepo(): Repo {
    if (!this.repo) {
      throw new Error(`Automerge repo for account ${this.accountId} has not been initialized`)
    }
    return this.repo
  }

  async clearLocalData(): Promise<void> {
    if (this.indexedDbAdapter) {
      await this.indexedDbAdapter.clear()
    }
  }

  async close(): Promise<void> {
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

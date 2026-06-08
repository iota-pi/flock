import { Repo, type StorageAdapterInterface, type Chunk } from '@automerge/automerge-repo/slim'
import { EncryptedBroadcastChannelNetworkAdapter } from './EncryptedBroadcastChannelNetworkAdapter'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { runStorageOperation } from '../utils/storageManager'

class QuotaHandlingStorageAdapter implements StorageAdapterInterface {
  constructor(private delegate: StorageAdapterInterface) {}

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return this.delegate.load(key)
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
    return runStorageOperation(() => this.delegate.save(key, data))
  }

  async remove(key: string[]): Promise<void> {
    return runStorageOperation(() => this.delegate.remove(key))
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    return this.delegate.loadRange(keyPrefix)
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    return runStorageOperation(() => this.delegate.removeRange(keyPrefix))
  }
}


const repos = new Map<string, Repo>()
const storageAdapters = new Map<string, IndexedDBStorageAdapter>()

export function getAutomergeDBName(accountId: string): string {
  return `flock-automerge-db-${accountId}`
}

export function initAutomergeRepo(
  accountId: string,
  adapter: VaultNetworkAdapter,
) {
  if (repos.has(accountId)) {
    throw new Error(`Automerge repo for account ${accountId} has already been initialized`)
  }

  const dbName = getAutomergeDBName(accountId)
  const indexedDbAdapter = new IndexedDBStorageAdapter(dbName)
  storageAdapters.set(accountId, indexedDbAdapter)

  const repo = new Repo({
    storage: new QuotaHandlingStorageAdapter(indexedDbAdapter),
    network: [
      new EncryptedBroadcastChannelNetworkAdapter({
        channelName: `flock-automerge-broadcast-${accountId}`,
      }),
      adapter,
    ],
  })
  repos.set(accountId, repo)

  return repo
}

export function getAutomergeRepo(accountId: string): Repo {
  const repo = repos.get(accountId)
  if (!repo) {
    throw new Error(`Automerge repo for account ${accountId} has not been initialized`)
  }
  return repo
}

export async function closeAutomergeRepo(accountId: string): Promise<void> {
  const repo = repos.get(accountId)
  if (repo) {
    try {
      await repo.shutdown()
    } catch (err) {
      console.error(`[automergeRepo] Error shutting down repo for ${accountId}:`, err)
    }
    repos.delete(accountId)
  }

  const adapter = storageAdapters.get(accountId)
  if (adapter) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbPromise = (adapter as any).dbPromise
      if (dbPromise) {
        const db = await dbPromise
        if (db && typeof db.close === 'function') {
          db.close()
        }
      }
    } catch (err) {
      console.error(`[automergeRepo] Error closing IndexedDB connection for ${accountId}:`, err)
    }
    storageAdapters.delete(accountId)
  }
}


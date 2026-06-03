import { Repo, type StorageAdapterInterface, type Chunk } from '@automerge/automerge-repo/slim'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { isQuotaError } from 'src/utils/storageQuota'
import { reportQuotaExceeded } from '../workers/quotaReporter'

class QuotaHandlingStorageAdapter implements StorageAdapterInterface {
  constructor(private delegate: StorageAdapterInterface) {}

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return this.delegate.load(key)
  }

  async save(key: string[], data: Uint8Array): Promise<void> {
    try {
      await this.delegate.save(key, data)
    } catch (err) {
      if (isQuotaError(err)) {
        reportQuotaExceeded()
      }
      throw err
    }
  }

  async remove(key: string[]): Promise<void> {
    try {
      await this.delegate.remove(key)
    } catch (err) {
      if (isQuotaError(err)) {
        reportQuotaExceeded()
      }
      throw err
    }
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    return this.delegate.loadRange(keyPrefix)
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    try {
      await this.delegate.removeRange(keyPrefix)
    } catch (err) {
      if (isQuotaError(err)) {
        reportQuotaExceeded()
      }
      throw err
    }
  }
}


const repos = new Map<string, Repo>()

function getFastHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0
  }
  return Math.abs(hash).toString(36)
}

export function getAutomergeDBName(accountId?: string): string {
  if (accountId) {
    return `flock-automerge-db-${getFastHash(accountId)}`
  }
  return 'flock-automerge-db'
}

export function initAutomergeRepo(
  accountId: string,
  adapter: VaultEncryptedNetworkAdapter,
) {
  if (repos.has(accountId)) {
    throw new Error(`Automerge repo for account ${accountId} has already been initialized`)
  }

  const dbName = getAutomergeDBName(accountId)

  const repo = new Repo({
    storage: new QuotaHandlingStorageAdapter(new IndexedDBStorageAdapter(dbName)),
    network: [
      new BroadcastChannelNetworkAdapter({
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

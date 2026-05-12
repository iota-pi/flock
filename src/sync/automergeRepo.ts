import { Repo } from '@automerge/automerge-repo/slim'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'


const vaultNetworkAdapters = new Map<string, VaultEncryptedNetworkAdapter>()
const repos = new Map<string, Repo>()

function getFastHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0
  }
  return Math.abs(hash).toString(36)
}

export function getAutomergeRepo(accountId: string): Repo {
  if (!repos.has(accountId)) {
    const adapter = new VaultEncryptedNetworkAdapter()
    vaultNetworkAdapters.set(accountId, adapter)

    const dbName = accountId
      ? `flock-automerge-db-${getFastHash(accountId)}`
      : 'flock-automerge-db'

    const repo = new Repo({
      storage: new IndexedDBStorageAdapter(dbName),
      network: [
        new BroadcastChannelNetworkAdapter({
          channelName: `flock-automerge-broadcast-${accountId}`,
        }),
        adapter,
      ],
    })

    repos.set(accountId, repo)
  }
  return repos.get(accountId)!
}

export function getVaultNetworkAdapter(accountId: string): VaultEncryptedNetworkAdapter {
  if (!vaultNetworkAdapters.has(accountId)) {
    getAutomergeRepo(accountId)
  }
  return vaultNetworkAdapters.get(accountId)!
}

export async function setVaultNetworkAccount(accountId: string | null): Promise<void> {
  if (accountId) {
    await getVaultNetworkAdapter(accountId).setAccount(accountId)
  } else {
    const promises: Promise<void>[] = []
    for (const adapter of vaultNetworkAdapters.values()) {
      promises.push(adapter.setAccount(null))
    }
    await Promise.all(promises)
  }
}

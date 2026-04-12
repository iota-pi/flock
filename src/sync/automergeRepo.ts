import { Repo } from '@automerge/automerge-repo/slim'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { useAuthStore } from '../state/authStore'

const vaultNetworkAdapters = new Map<string, VaultEncryptedNetworkAdapter>()
const repos = new Map<string, Repo>()

function getFastHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0
  }
  return Math.abs(hash).toString(36)
}

export function getAutomergeRepo(accountId?: string | null): Repo {
  const resolvedAccount = accountId !== undefined ? accountId : useAuthStore.getState().account
  const accountKey = resolvedAccount || 'public'
  if (!repos.has(accountKey)) {
    const adapter = new VaultEncryptedNetworkAdapter()
    vaultNetworkAdapters.set(accountKey, adapter)

    const dbName = resolvedAccount
      ? `flock-automerge-db-${getFastHash(resolvedAccount)}`
      : 'flock-automerge-db'

    const repo = new Repo({
      storage: new IndexedDBStorageAdapter(dbName),
      network: [
        new BroadcastChannelNetworkAdapter({
          channelName: `flock-automerge-broadcast-${accountKey}`,
        }),
        adapter,
      ],
    })

    repos.set(accountKey, repo)
  }
  return repos.get(accountKey)!
}

export function getVaultNetworkAdapter(accountId?: string | null): VaultEncryptedNetworkAdapter {
  const resolvedAccount = accountId !== undefined ? accountId : useAuthStore.getState().account
  const accountKey = resolvedAccount || 'public'
  if (!vaultNetworkAdapters.has(accountKey)) {
    getAutomergeRepo(resolvedAccount)
  }
  return vaultNetworkAdapters.get(accountKey)!
}

export function setVaultNetworkAccount(account: string | null): void {
  // Sets the session for the given account's network adapter.
  getVaultNetworkAdapter(account).setAccount(account)
}


import { Repo } from '@automerge/automerge-repo/slim'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'

const vaultNetworkAdapter = new VaultEncryptedNetworkAdapter()

const repo = new Repo({
  storage: new IndexedDBStorageAdapter('flock-automerge-db'),
  network: [
    new BroadcastChannelNetworkAdapter({
      channelName: 'flock-automerge-broadcast',
    }),
    vaultNetworkAdapter,
  ],
})

export function getAutomergeRepo(): Repo {
  return repo
}

export function getVaultNetworkAdapter(): VaultEncryptedNetworkAdapter {
  return vaultNetworkAdapter
}

export function setVaultNetworkAccount(account: string | null): void {
  vaultNetworkAdapter.setAccount(account)
}

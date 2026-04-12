import { Repo } from '@automerge/automerge-repo/slim'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'

let vaultNetworkAdapter: VaultEncryptedNetworkAdapter | null = null
let repo: Repo | null = null

export function getAutomergeRepo(): Repo {
  if (!repo) {
    vaultNetworkAdapter = new VaultEncryptedNetworkAdapter()
    repo = new Repo({
      storage: new IndexedDBStorageAdapter('flock-automerge-db'),
      network: [
        new BroadcastChannelNetworkAdapter({
          channelName: 'flock-automerge-broadcast',
        }),
        vaultNetworkAdapter,
      ],
    })
  }
  return repo
}

export function getVaultNetworkAdapter(): VaultEncryptedNetworkAdapter {
  if (!vaultNetworkAdapter) {
    getAutomergeRepo()
  }
  return vaultNetworkAdapter!
}

export function setVaultNetworkAccount(account: string | null): void {
  getVaultNetworkAdapter().setAccount(account)
}

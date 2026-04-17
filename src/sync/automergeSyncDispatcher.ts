import { useSyncStore } from '../state/syncStore'
import { setVaultNetworkAccount } from './automergeRepo'

export function startAutomergeSyncDispatcher(account: string): void {
  if (!account) {
    return
  }

  setVaultNetworkAccount(account)
}

export function stopAutomergeSyncDispatcher(): void {
  setVaultNetworkAccount(null)
  useSyncStore.getState().setIsSyncing(false)
}

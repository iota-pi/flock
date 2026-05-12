import { useSyncStore } from '../state/syncStore'
import { setVaultNetworkAccount } from './automergeRepo'

export async function startAutomergeSyncDispatcher(account: string): Promise<void> {
  if (!account) {
    return
  }

  await setVaultNetworkAccount(account)
}

export async function stopAutomergeSyncDispatcher(): Promise<void> {
  await setVaultNetworkAccount(null)
  useSyncStore.getState().setSyncStatus('idle')
}

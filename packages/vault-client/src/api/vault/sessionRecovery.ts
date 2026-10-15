import { getVaultSession, getKeyHash, establishSessionFromKeyHash, syncKeyringFromServer } from './index'

export async function attemptSessionRecovery(account: string): Promise<boolean> {
  if (getVaultSession()) {
    return true
  }
  const keyHash = getKeyHash()
  if (!keyHash) {
    return false
  }

  try {
    await establishSessionFromKeyHash(account, keyHash)
    await syncKeyringFromServer(account)
    return true
  } catch (err) {
    console.warn('[sessionRecovery] Failed to recover session on reconnect:', err)
    return false
  }
}

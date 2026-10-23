import { getVaultSession, getKeyHash, establishSessionFromKeyHash } from './session'
import { syncKeyringFromServer } from './vault'
import { createLogger } from '../sync/utils/logger'

const log = createLogger('sessionRecovery')

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
    log.warn('Failed to recover session on reconnect:', err)
    return false
  }
}

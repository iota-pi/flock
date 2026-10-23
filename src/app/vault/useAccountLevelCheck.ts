import { useEffect } from 'react'
import { createLogger, getSecurityParams } from '@vault/client'
import { goToMigration, isMigrationDeferred, MIN_ACCOUNT_DATA_VERSION } from '../../migrate/detection'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { lockVault } from './session'

const log = createLogger('useAccountLevelCheck')

/**
 * Sends an unlocked account below the minimum level to the migration app. The login page checks
 * this before deriving keys, but an offline login (from cached parameters) and biometric unlock
 * skip that check, so this runs after every unlock, once the device is online.
 */
export async function checkAccountLevel(account: string, isCancelled: () => boolean = () => false): Promise<void> {
  let params: Awaited<ReturnType<typeof getSecurityParams>>
  try {
    params = await getSecurityParams(account)
  } catch (error) {
    // Unreachable: checked again when the device is next online
    log.warn('getSecurityParams failed', error)
    return
  }
  if (isCancelled()) return

  // An account still on PBKDF2 always goes; deferring is only offered once it has moved to Argon2id
  const belowMinimum = params.dataVersion < MIN_ACCOUNT_DATA_VERSION && !isMigrationDeferred(account)
  if (params.kdf && !belowMinimum) return

  await lockVault()
  goToMigration(account)
}

export default function useAccountLevelCheck(account: string | null | undefined, loggedIn: boolean): void {
  const isOnline = useOnlineStatus()

  useEffect(() => {
    if (!loggedIn || !account || !isOnline) return undefined
    let cancelled = false
    void checkAccountLevel(account, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [account, isOnline, loggedIn])
}

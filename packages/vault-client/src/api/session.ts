import { deleteStoredSessionToken } from '../sync/shared/workerAuthStore'
import { createLogger } from '../sync/utils/logger'
import { SingleFlightGuard } from '../sync/utils/SingleFlightGuard'
import { getSession } from './AccountClient'
import { setApiAuthToken, setApiSessionExpiredHandler } from './runtime'
import { readStoredMetadata } from './storedMetadata'
import { getHostHooks } from './vaultHost'
import { vaultKeys } from './VaultKeyState'

const log = createLogger('session')

/** How long a login waits for the server once the cached keyring has verified the password */
const LOGIN_SERVER_WAIT_MS = 3000

const sessionExpiry = new SingleFlightGuard()
const lateSessionListeners = new Set<() => void>()

export function getKeyHash(): string {
  return vaultKeys.keyHash
}

export function getVaultSession() {
  return vaultKeys.session
}

export async function establishSessionFromKeyHash(account: string, nextKeyHash: string) {
  const generation = vaultKeys.currentGeneration
  const nextSession = await getSession(account, nextKeyHash)
  if (!vaultKeys.isCurrent(generation)) {
    throw new Error('The vault was locked before the session was established')
  }
  vaultKeys.activeAccount = account
  vaultKeys.keyHash = nextKeyHash
  vaultKeys.session = nextSession
  setApiAuthToken(nextSession)
  setApiSessionExpiredHandler(handleSessionExpired)
  // The session is kept only in memory: this removes one an earlier build stored
  await deleteStoredSessionToken()
}

/** Tries a silent re-login, telling the host the session is lost if that fails. Concurrent calls share one attempt. */
export function handleSessionExpired(): Promise<void> {
  return sessionExpiry.run(async () => {
    const { keyHash } = vaultKeys
    const account = vaultKeys.activeAccount || readStoredMetadata()?.account || getHostHooks().getAccountId?.()

    if (account && keyHash) {
      try {
        await establishSessionFromKeyHash(account, keyHash)
        log.info('Session silently re-established')
        return
      } catch (err) {
        log.warn('Silent session re-establishment failed:', err)
      }
    }

    vaultKeys.session = ''
    setApiAuthToken('')
    getHostHooks().onSessionLost?.(
      'Sync paused: unable to re-establish session. Please re-enter your password to resume syncing.'
    )
  })
}

/**
 * Calls `listener` when a login that stopped waiting for the server (see `loginVault`) later gets a
 * session and the server's keyring. Returns a function that removes the listener.
 */
export function onLateSession(listener: () => void): () => void {
  lateSessionListeners.add(listener)
  return () => {
    lateSessionListeners.delete(listener)
  }
}

export function notifyLateSession() {
  for (const listener of lateSessionListeners) {
    listener()
  }
}

/** Resolves (to undefined) once a login has waited long enough for the server */
function serverWaitElapsed(): Promise<undefined> {
  return new Promise(resolve => setTimeout(resolve, LOGIN_SERVER_WAIT_MS))
}

/**
 * Starts a login's server session. Once the cached keyring has unlocked the vault (`canWaitLess`), a
 * slow server doesn't hold up unlocking: this resolves to undefined after a short wait, and
 * `finishLate` gets the outcome when it arrives, unless the vault was locked in the meantime.
 */
export async function attemptSession<T extends NonNullable<unknown>>(
  start: () => Promise<T>,
  { canWaitLess, finishLate }: { canWaitLess: boolean, finishLate: (outcome: T) => Promise<void> | void },
): Promise<T | undefined> {
  const generation = vaultKeys.currentGeneration
  const attempt = start()
  const outcome = canWaitLess ? await Promise.race([attempt, serverWaitElapsed()]) : await attempt
  if (outcome === undefined) {
    log.info('The server is slow to respond; finishing the session in the background')
    void attempt
      .then(late => vaultKeys.isCurrent(generation) ? finishLate(late) : undefined)
      .catch((err: unknown) => log.warn('Failed to finish the session in the background:', err))
  }
  return outcome
}

/** Forgets the keys and the session, in this realm only */
export function clearKeyData() {
  vaultKeys.clear()
  setApiAuthToken('')
  setApiSessionExpiredHandler(null)
}

/** Fails a login or unlock that ended up without any data keys, which can't decrypt anything */
export function assertKeyringLoaded() {
  if (!vaultKeys.keyring.hasKey()) {
    clearKeyData()
    throw new Error('Could not load your encryption keys. Check your connection and try again.')
  }
}

/**
 * Forgets the in-memory keys and the session token. The host app is responsible for stopping sync
 * and updating its own state.
 */
export async function lockVaultKeys() {
  clearKeyData()
  await deleteStoredSessionToken()
}

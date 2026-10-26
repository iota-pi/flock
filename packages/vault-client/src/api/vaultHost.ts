import { deriveVaultKey, type DeriveLegacyKey } from './crypto'
import { setKdfWorkerFactory } from './kdf'
import type { VaultBroadcastEvent } from './vaultEvents'
import { getVaultStorageNames } from '../sync/shared/storageNames'

export interface VaultHostHooks {
  /** Account to restore the session for when none has been established in this realm yet */
  getAccountId?: () => string | undefined
  /** Called when the session has expired and could not be silently re-established */
  onSessionLost?: (message: string) => void
  /**
   * Called when the server turned away a write because this build is too old, from any realm or
   * tab. The app should update itself (fetch the new service worker and reload).
   */
  onClientOutdated?: () => void
  /**
   * Decodes salts from before `saltVersion` 1, so accounts that still use them can log in (and be
   * upgraded). Without it, logging in to such an account fails.
   */
  decodeLegacySalt?: (salt: string) => ArrayBuffer
  /**
   * Derives PBKDF2 keys, for accounts without Argon2id parameters. Without it, logging in to such
   * an account fails with `UnsupportedKeyDerivationError`.
   */
  deriveLegacyKey?: DeriveLegacyKey
  /**
   * Creates a worker that calls `exposeKdfWorker` (from `@vault/client/kdfWorker`), so Argon2id
   * runs off the main thread. Without it, Argon2id runs in the calling realm.
   */
  createKdfWorker?: () => Worker
}

let hostHooks: VaultHostHooks = {}
let vaultEventsListener: BroadcastChannel | null = null

/** Connects the vault to the host app. Call once at startup on the main thread. */
export function configureVaultHost(hooks: VaultHostHooks): void {
  hostHooks = hooks
  setKdfWorkerFactory(hooks.createKdfWorker)

  vaultEventsListener?.close()
  vaultEventsListener = null
  if (hooks.onClientOutdated && typeof BroadcastChannel !== 'undefined') {
    vaultEventsListener = new BroadcastChannel(getVaultStorageNames().vaultEventsChannel)
    vaultEventsListener.onmessage = (event: MessageEvent<VaultBroadcastEvent>) => {
      if (event.data?.type === 'CLIENT_OUTDATED') {
        hostHooks.onClientOutdated?.()
      }
    }
  }
}

export function getHostHooks(): VaultHostHooks {
  return hostHooks
}

/** Derives a master key, with the host's support for legacy salts and PBKDF2 */
export function deriveMasterKey(
  params: Omit<Parameters<typeof deriveVaultKey>[0], 'decodeLegacySalt' | 'deriveLegacyKey'>,
): Promise<CryptoKey> {
  return deriveVaultKey({
    ...params,
    decodeLegacySalt: hostHooks.decodeLegacySalt,
    deriveLegacyKey: hostHooks.deriveLegacyKey,
  })
}

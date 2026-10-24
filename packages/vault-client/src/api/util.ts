import { getVaultStorageNames } from '../sync/shared/storageNames'
import { createLogger } from '../sync/utils/logger'

const log = createLogger('util')

const isCypress = typeof window !== 'undefined' && !!(window as Window & { Cypress?: unknown }).Cypress
export const DEFAULT_CRYPTO_ITERATIONS = isCypress ? 1 : 600000
export const LEGACY_CRYPTO_ITERATIONS = isCypress ? 1 : 100000
/** Waits between attempts to fetch the keyring when an unlock has no other keys to use */
export const KEYRING_FETCH_RETRY_DELAYS: readonly number[] = [500, 2000]

export type VaultBroadcastEvent =
  | { type: 'KEY_ROTATED'; account: string; keyVersion: string }
  | { type: 'PASSWORD_CHANGED'; account: string }
  /** The server turned away a write because this build is too old */
  | { type: 'CLIENT_OUTDATED' }

/** Tells every other tab and realm (including other listeners in this one) about a vault event */
export function broadcastVaultEvent(event: VaultBroadcastEvent): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(getVaultStorageNames().vaultEventsChannel)
    channel.postMessage(event)
    channel.close()
  } catch (err) {
    log.warn('Failed to broadcast vault event:', err)
  }
}

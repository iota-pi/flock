import { getVaultStorageNames } from '../sync/shared/storageNames'
import { createLogger } from '../sync/utils/logger'

const log = createLogger('vaultEvents')

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

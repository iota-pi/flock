import { getVaultStorageNames } from '../shared/storageNames'
import { createLogger } from '../utils/logger'

const log = createLogger('vaultEvents')

/** Identifies this realm, so it can ignore the events it sent itself */
const REALM_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`

export type VaultBroadcastEvent =
  | { type: 'KEY_ROTATED'; account: string; keyVersion: string }
  | { type: 'PASSWORD_CHANGED'; account: string }
  /** The server turned away a write because this build is too old */
  | { type: 'CLIENT_OUTDATED' }
  /** The user locked the vault in one tab, so every other tab locks too */
  | { type: 'VAULT_LOCKED'; account: string; source: string }
  /**
   * The user is removing the account from this device, so every other tab locks (closing its
   * databases) before the local data is deleted
   */
  | { type: 'VAULT_REMOVED'; account: string; source: string }

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

/** Asks every other tab to lock the account, as the user just did in this one */
export function announceVaultLocked(account: string): void {
  broadcastVaultEvent({ type: 'VAULT_LOCKED', account, source: REALM_ID })
}

/**
 * Asks every other tab to lock the account before this one deletes its local data. Call it before
 * shutting sync down, so their connections to the databases close in time for the deletion.
 */
export function announceVaultRemoved(account: string): void {
  broadcastVaultEvent({ type: 'VAULT_REMOVED', account, source: REALM_ID })
}

/** Whether this realm sent the event */
export function isOwnVaultEvent(event: { source?: string }): boolean {
  return event.source === REALM_ID
}

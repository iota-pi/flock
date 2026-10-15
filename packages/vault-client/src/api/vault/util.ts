import { getVaultStorageNames } from '../../sync/shared/storageNames'

const isCypress = typeof window !== 'undefined' && !!(window as Window & { Cypress?: unknown }).Cypress
export const DEFAULT_CRYPTO_ITERATIONS = isCypress ? 1 : 600000
export const LEGACY_CRYPTO_ITERATIONS = isCypress ? 1 : 100000

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
    console.warn('[vault] Failed to broadcast vault event:', err)
  }
}

export type VaultStoredMetadata = {
  account: string,
  salt?: string,
  iterations?: number,
  saltVersion?: number,
}

export function readStoredMetadata(): VaultStoredMetadata | null {
  const serialized = localStorage.getItem(getVaultStorageNames().vaultMetadataKey)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<VaultStoredMetadata>
      if (typeof parsed.account === 'string') {
        return {
          account: parsed.account,
          salt: typeof parsed.salt === 'string' ? parsed.salt : undefined,
          iterations: typeof parsed.iterations === 'number' ? parsed.iterations : undefined,
          saltVersion: typeof parsed.saltVersion === 'number' ? parsed.saltVersion : undefined,
        }
      }
    } catch {
      localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
    }
  }

  return null
}


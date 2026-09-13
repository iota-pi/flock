import { getOnlineState } from 'src/utils/onlineStatus'
import {
  KEYRING_CACHE_KEY,
  VAULT_EVENTS_CHANNEL,
  type VaultBroadcastEvent,
} from 'src/api/vault'

export interface SyncDOMListenersCallbacks {
  onOnlineChange: (isOnline: boolean) => void
  onVisibilityHidden: () => void
  onKeyringChange: () => void
}

export class SyncDOMListeners {
  private onlineHandler: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null
  private storageHandler: ((event: StorageEvent) => void) | null = null
  private vaultEventsChannel: BroadcastChannel | null = null

  start(callbacks: SyncDOMListenersCallbacks): void {
    if (!this.onlineHandler && typeof window !== 'undefined') {
      this.onlineHandler = () => {
        callbacks.onOnlineChange(getOnlineState())
      }
      window.addEventListener('online', this.onlineHandler)
      window.addEventListener('offline', this.onlineHandler)
    }

    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          callbacks.onVisibilityHidden()
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', this.visibilityHandler)
      }
    }

    if (!this.storageHandler && typeof window !== 'undefined') {
      this.storageHandler = (event: StorageEvent) => {
        if (event.key === KEYRING_CACHE_KEY) {
          callbacks.onKeyringChange()
        }
      }
      window.addEventListener('storage', this.storageHandler)
    }

    if (!this.vaultEventsChannel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.vaultEventsChannel = new BroadcastChannel(VAULT_EVENTS_CHANNEL)
        this.vaultEventsChannel.onmessage = (ev: MessageEvent<VaultBroadcastEvent>) => {
          if (ev.data?.type === 'KEY_ROTATED' || ev.data?.type === 'PASSWORD_CHANGED') {
            callbacks.onKeyringChange()
          }
        }
      } catch (err) {
        console.warn('[SyncDOMListeners] Failed to create vault events BroadcastChannel:', err)
      }
    }
  }

  stop(): void {
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler)
      window.removeEventListener('offline', this.onlineHandler)
      this.onlineHandler = null
    }

    if (this.visibilityHandler) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.visibilityHandler)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', this.visibilityHandler)
      }
      this.visibilityHandler = null
    }

    if (this.storageHandler && typeof window !== 'undefined') {
      window.removeEventListener('storage', this.storageHandler)
      this.storageHandler = null
    }

    if (this.vaultEventsChannel) {
      this.vaultEventsChannel.close()
      this.vaultEventsChannel = null
    }
  }
}

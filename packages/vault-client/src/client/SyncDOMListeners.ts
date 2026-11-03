import { getOnlineState } from '../utils/onlineStatus'
import type { VaultBroadcastEvent } from '../keys/vaultEvents'
import { getVaultStorageNames } from '../shared/storageNames'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncDOMListeners')

export interface SyncDOMListenersCallbacks {
  setOnlineState?: (isOnline: boolean) => Promise<void> | void
  onOnlineChange?: (isOnline: boolean) => Promise<void> | void
  onReconnect?: () => Promise<void> | void
  onVisibilityHidden: () => void
  /**
   * The page's visibility: reported when listening starts, when it changes, and when the window gets
   * focus. `returned` says the user just came back to the page (it became visible or got focus).
   */
  onVisibilityChange?: (visible: boolean, returned: boolean) => void
  onKeyringChange: () => void
}

export class SyncDOMListeners {
  private callbacks: SyncDOMListenersCallbacks | null = null
  private onlineHandler: (() => void) | null = null
  private visibilityHandler: ((event?: Event) => void) | null = null
  private focusHandler: (() => void) | null = null
  private storageHandler: ((event: StorageEvent) => void) | null = null
  private vaultEventsChannel: BroadcastChannel | null = null
  private eventSequence = 0

  start(callbacks: SyncDOMListenersCallbacks): void {
    this.callbacks = callbacks

    if (!this.onlineHandler && typeof window !== 'undefined') {
      this.onlineHandler = () => {
        fireAndForget(this.handleNetworkChange(), 'SyncDOMListeners:handleNetworkChange')
      }
      window.addEventListener('online', this.onlineHandler)
      window.addEventListener('offline', this.onlineHandler)
    }

    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = (event?: Event) => {
        if (document.visibilityState === 'hidden') {
          this.callbacks?.onVisibilityHidden()
          this.callbacks?.onVisibilityChange?.(false, false)
        } else if (document.visibilityState === 'visible' && event?.type !== 'pagehide') {
          this.callbacks?.onVisibilityChange?.(true, true)
        }
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', this.visibilityHandler)
      }
    }

    if (!this.focusHandler && typeof window !== 'undefined' && typeof document !== 'undefined') {
      // A window beside another one stays visible, so coming back to it only shows as focus
      this.focusHandler = () => {
        if (document.visibilityState === 'visible') {
          this.callbacks?.onVisibilityChange?.(true, true)
        }
      }
      window.addEventListener('focus', this.focusHandler)
    }

    if (typeof document !== 'undefined') {
      this.callbacks.onVisibilityChange?.(document.visibilityState !== 'hidden', false)
    }

    if (!this.storageHandler && typeof window !== 'undefined') {
      this.storageHandler = (event: StorageEvent) => {
        if (event.key === getVaultStorageNames().keyringCacheKey) {
          this.callbacks?.onKeyringChange()
        }
      }
      window.addEventListener('storage', this.storageHandler)
    }

    if (!this.vaultEventsChannel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.vaultEventsChannel = new BroadcastChannel(getVaultStorageNames().vaultEventsChannel)
        this.vaultEventsChannel.onmessage = (ev: MessageEvent<VaultBroadcastEvent>) => {
          if (ev.data?.type === 'KEY_ROTATED' || ev.data?.type === 'PASSWORD_CHANGED') {
            this.callbacks?.onKeyringChange()
          }
        }
      } catch (err) {
        log.warn('Failed to create vault events BroadcastChannel:', err)
      }
    }
  }

  private async handleNetworkChange(): Promise<void> {
    try {
      const currentCallbacks = this.callbacks
      if (!currentCallbacks) return

      this.eventSequence += 1
      const seq = this.eventSequence
      const isOnline = getOnlineState()

      if (!isOnline) {
        if (currentCallbacks.setOnlineState) {
          await currentCallbacks.setOnlineState(false)
        }
        if (currentCallbacks.onOnlineChange) {
          await currentCallbacks.onOnlineChange(false)
        }
        return
      }

      // Step 1: Update online state in worker and await completion
      if (currentCallbacks.setOnlineState) {
        await currentCallbacks.setOnlineState(true)
      }
      if (currentCallbacks.onOnlineChange) {
        await currentCallbacks.onOnlineChange(true)
      }

      // If a newer event arrived while awaiting setOnlineState, or if offline / stopped, abort
      if (seq !== this.eventSequence || !getOnlineState() || !this.callbacks) {
        return
      }

      // Step 2: Trigger onReconnect callback
      if (currentCallbacks.onReconnect) {
        try {
          await currentCallbacks.onReconnect()
        } catch (error) {
          log.error('onReconnect callback failed:', error)
        }
      }
    } catch (err) {
      log.error('Error handling network change:', err)
    }
  }

  stop(): void {
    this.callbacks = null
    this.eventSequence += 1

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

    if (this.focusHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', this.focusHandler)
      this.focusHandler = null
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

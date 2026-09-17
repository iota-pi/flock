import { getOnlineState } from 'src/utils/onlineStatus'
import {
  KEYRING_CACHE_KEY,
  VAULT_EVENTS_CHANNEL,
  type VaultBroadcastEvent,
} from 'src/api/vault'
import { attemptSessionRecovery } from 'src/api/vault/sessionRecovery'
import { useAppStore } from 'src/state/store'

export interface SyncDOMListenersCallbacks {
  setOnlineState?: (isOnline: boolean) => Promise<void> | void
  onOnlineChange?: (isOnline: boolean) => Promise<void> | void
  getAccountId?: () => string | null
  attemptSessionRecovery?: (account: string) => Promise<boolean>
  flushSync?: () => Promise<void>
  resumePendingReencryption?: (account: string) => Promise<void>
  onVisibilityHidden: () => void
  onKeyringChange: () => void
}

export class SyncDOMListeners {
  private callbacks: SyncDOMListenersCallbacks | null = null
  private onlineHandler: (() => void) | null = null
  private visibilityHandler: (() => void) | null = null
  private storageHandler: ((event: StorageEvent) => void) | null = null
  private vaultEventsChannel: BroadcastChannel | null = null
  private eventSequence = 0

  start(callbacks: SyncDOMListenersCallbacks): void {
    this.callbacks = callbacks

    if (!this.onlineHandler && typeof window !== 'undefined') {
      this.onlineHandler = () => {
        void this.handleNetworkChange()
      }
      window.addEventListener('online', this.onlineHandler)
      window.addEventListener('offline', this.onlineHandler)
    }

    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'hidden') {
          this.callbacks?.onVisibilityHidden()
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
          this.callbacks?.onKeyringChange()
        }
      }
      window.addEventListener('storage', this.storageHandler)
    }

    if (!this.vaultEventsChannel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.vaultEventsChannel = new BroadcastChannel(VAULT_EVENTS_CHANNEL)
        this.vaultEventsChannel.onmessage = (ev: MessageEvent<VaultBroadcastEvent>) => {
          if (ev.data?.type === 'KEY_ROTATED' || ev.data?.type === 'PASSWORD_CHANGED') {
            this.callbacks?.onKeyringChange()
          }
        }
      } catch (err) {
        console.warn('[SyncDOMListeners] Failed to create vault events BroadcastChannel:', err)
      }
    }
  }

  private async handleNetworkChange(): Promise<void> {
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

    // Step 2: Session recovery
    const account = currentCallbacks.getAccountId ? currentCallbacks.getAccountId() : null
    if (!account) {
      return
    }

    const recoverSession = currentCallbacks.attemptSessionRecovery ?? attemptSessionRecovery
    let recovered = false
    try {
      recovered = await recoverSession(account)
    } catch (err) {
      console.warn('[SyncDOMListeners] Failed to attempt session recovery on reconnect:', err)
    }

    // If a newer event arrived while recovering session, or if offline / stopped, abort
    if (seq !== this.eventSequence || !getOnlineState() || !this.callbacks) {
      return
    }

    // Step 3: Flush sync if session recovered
    if (recovered) {
      useAppStore.getState().clearSyncWarning()
      if (currentCallbacks.flushSync) {
        try {
          await currentCallbacks.flushSync()
        } catch (error) {
          console.error('[SyncDOMListeners] flushSync failed on reconnect:', error)
        }
      }
    }

    // Resume pending re-encryption
    const resumeReencryptionFn = currentCallbacks.resumePendingReencryption ?? (async (acc: string) => {
      const { resumePendingReencryption } = await import('src/api/vault/reencrypt')
      await resumePendingReencryption(acc)
    })

    try {
      await resumeReencryptionFn(account)
    } catch (error) {
      console.warn('[SyncDOMListeners] resumePendingReencryption failed on reconnect:', error)
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

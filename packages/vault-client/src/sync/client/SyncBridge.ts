import type * as Comlink from 'comlink'

import { hasVaultKey, reloadKeyringFromStorage, syncKeyringFromServer } from '../../api/vault'
import { handleSessionExpired, getVaultSession, onLateSession } from '../../api/session'
import type { ManualRecoveryEntry, ReadManualRecoveryOptions } from '../shared/manualRecoveryStore'
import type { ReencryptResult, VaultDoc, VaultMetadata } from '../shared/types'
import type { SyncApi } from '../worker/syncProtocol'
import { WorkerLifecycleManager } from './WorkerLifecycleManager'
import { SyncEventProcessor } from './SyncEventProcessor'
import { SyncDOMListeners } from './SyncDOMListeners'
import { attemptSessionRecovery } from '../../api/sessionRecovery'
import { resumePendingReencryption } from '../../api/reencrypt'
import { getOnlineState } from '../utils/onlineStatus'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { noopTelemetry, type SyncStateSink, type SyncTelemetry } from './host'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncBridge')

export interface SyncBridgeOptions<TDoc extends VaultDoc, TMeta extends VaultMetadata> {
  /** Creates the app's sync worker (whose entry file calls exposeSyncWorker) */
  createWorker: () => Worker
  sink: SyncStateSink<TDoc, TMeta>
  getAccountId: () => string | null
  telemetry?: SyncTelemetry
  /** Locks the vault, for example after the password was changed on another device */
  lockVault: () => Promise<void>
}

/**
 * Main-thread facade over the sync worker. Apps create one instance with createSyncBridge.
 */
export class SyncBridgeService<TDoc extends VaultDoc = VaultDoc, TMeta extends VaultMetadata = VaultMetadata> {
  private readonly sink: SyncStateSink<TDoc, TMeta>
  private readonly telemetry: SyncTelemetry
  private eventProcessor: SyncEventProcessor<TDoc, TMeta>
  private domListeners: SyncDOMListeners
  private lifecycleManager: WorkerLifecycleManager
  private keyringUpdateGuard = new SingleFlightGuard<void>()
  private pendingMissingKeyVersions = new Set<string>()
  /** The versions the latest keyring update looked for, so a version it couldn't find isn't retried at once */
  private checkedMissingKeyVersions = new Set<string>()
  private stopLateSessionListener: (() => void) | null = null
  /** Starts in a row that found local data it couldn't open, per account */
  private localDataFailures = new Map<string, number>()

  constructor(private readonly options: SyncBridgeOptions<TDoc, TMeta>) {
    this.sink = options.sink
    this.telemetry = options.telemetry ?? noopTelemetry
    this.eventProcessor = new SyncEventProcessor<TDoc, TMeta>(this.sink, {
      onKeyVersionMissing: kver => {
        fireAndForget(this.handleKeyringUpdate(kver), 'SyncBridge:handleKeyringUpdate')
      },
      onLocalDataUnavailable: details => {
        fireAndForget(this.handleLocalDataUnavailable(details), 'SyncBridge:handleLocalDataUnavailable')
      },
      onTokenRefreshNeeded: () => {
        fireAndForget(this.handleTokenRefresh(), 'SyncBridge:handleTokenRefresh')
      },
      onActivity: () => {
        this.lifecycleManager.recordWorkerActivity()
      },
    }, this.telemetry)

    this.domListeners = new SyncDOMListeners()

    this.lifecycleManager = new WorkerLifecycleManager({
      createWorker: options.createWorker,
      telemetry: this.telemetry,
      onEvent: event => {
        this.eventProcessor.handleSyncEvent(event)
      },
      onStatusChange: status => {
        this.sink.setSyncStatus(status)
        this.telemetry.setTag('syncStatus', status)
        this.telemetry.addBreadcrumb({
          category: 'sync',
          message: `Sync status changed to ${status}`,
          level: status === 'offline' ? 'warning' : 'info',
        })
      },
      onSyncWarning: warning => {
        if (warning) {
          this.sink.setSyncWarning(warning)
          this.telemetry.addBreadcrumb({
            category: 'sync',
            message: `Sync warning: ${warning}`,
            level: 'warning',
          })
        } else {
          this.sink.clearSyncWarning()
        }
      },
      onFatalError: error => {
        this.sink.setFatalError(error)
      },
      getAccountId: options.getAccountId,
      onReady: () => {
        this.localDataFailures.clear()
        this.stopLateSessionListener ??= onLateSession(() => {
          fireAndForget(this.handleLateSession(), 'SyncBridge:handleLateSession')
        })
        this.domListeners.start({
          setOnlineState: async isOnline => {
            this.telemetry.setTag('online', isOnline)
            this.telemetry.addBreadcrumb({
              category: 'network',
              message: isOnline ? 'Network online' : 'Network offline',
              level: isOnline ? 'info' : 'warning',
            })
            const api = this.lifecycleManager.getSyncApi()
            if (api) await api.setOnlineState(isOnline)
          },
          onReconnect: async () => {
            await this.handleReconnect()
          },
          onVisibilityHidden: () => {
            const api = this.lifecycleManager.getSyncApi()
            if (api) fireAndForget(api.pushSnapshots(), 'SyncBridge:pushSnapshots')
          },
          onKeyringChange: () => {
            fireAndForget(this.handleKeyringUpdate(), 'SyncBridge:handleKeyringUpdate')
          },
        })
      },
      onRestart: async (accountId: string) => {
        await this.initialize(accountId)
      },
      onShutdownCleanup: shutdownOptions => {
        if (!shutdownOptions?.internalRestart) {
          this.telemetry.setUser(null)
          this.eventProcessor.reset()
          this.sink.reset()
          this.domListeners.stop()
          this.stopLateSessionListener?.()
          this.stopLateSessionListener = null
          this.keyringUpdateGuard.clear()
          this.pendingMissingKeyVersions.clear()
        }
      },
    })
  }

  private reconnectSequence = 0

  private handleReconnect = async (): Promise<void> => {
    this.reconnectSequence += 1
    const currentSeq = this.reconnectSequence
    const account = this.lifecycleManager.getCurrentAccountId()
    if (!account) return

    let recovered = false
    try {
      recovered = await attemptSessionRecovery(account)
    } catch (err) {
      log.warn('Failed to attempt session recovery on reconnect:', err)
    }

    if (
      currentSeq !== this.reconnectSequence ||
      !getOnlineState() ||
      this.lifecycleManager.getCurrentAccountId() !== account
    ) {
      return
    }

    if (recovered) {
      this.sink.clearSyncWarning()
      const api = this.lifecycleManager.getSyncApi()
      if (api) {
        try {
          await api.flushSync()
        } catch (error) {
          log.error('flushSync failed on reconnect:', error)
        }
      }
    }

    try {
      await resumePendingReencryption(this, account)
    } catch (error) {
      log.warn('resumePendingReencryption failed on reconnect:', error)
    }
  }

  /** Catches up once a login that went ahead without the server gets a session (see loginVault) */
  private handleLateSession = async (): Promise<void> => {
    const syncApi = this.lifecycleManager.getSyncApi()
    if (syncApi) {
      try {
        await syncApi.updateAuthToken(getVaultSession() || null)
      } catch (err) {
        log.warn('Failed to pass the late session to the worker:', err)
      }
    }
    await this.handleKeyringUpdate()
    await this.handleReconnect()
  }

  /**
   * The first time a start can't open local data, the key it needs may just be missing from this
   * tab's keyring: it's fetched from the server, and the next start attempt (which exports the keyring
   * again) uses it. A second failure in a row stops sync and leaves the choice to the user.
   */
  private handleLocalDataUnavailable = async (details: { kver?: string, unpushedChanges: number }) => {
    const accountId = this.lifecycleManager.getCurrentAccountId()
    if (!accountId) return
    const failures = (this.localDataFailures.get(accountId) ?? 0) + 1
    this.localDataFailures.set(accountId, failures)
    if (failures === 1) {
      if (details.kver && !hasVaultKey(details.kver)) {
        try {
          await syncKeyringFromServer(accountId)
        } catch (err) {
          log.warn('Failed to reload the keyring for local data:', err)
        }
      }
      return
    }
    this.localDataFailures.delete(accountId)
    await this.shutdown({ clearLocalData: false })
    this.sink.onLocalDataUnavailable?.({ unpushedChanges: details.unpushedChanges })
  }

  private handleKeyringUpdate = async (kver?: string) => {
    if (kver) {
      this.pendingMissingKeyVersions.add(kver)
    }

    do {
      await this.keyringUpdateGuard.run(async () => {
        const currentAccountId = this.lifecycleManager.getCurrentAccountId()
        if (!currentAccountId) {
          this.pendingMissingKeyVersions.clear()
          return
        }
        let result = await reloadKeyringFromStorage()
        if (result.passwordChanged) {
          log.warn('Password changed in another tab/device. Locking vault.')
          this.pendingMissingKeyVersions.clear()
          await this.options.lockVault()
          return
        }
        const keysToCheck = Array.from(this.pendingMissingKeyVersions)
        this.checkedMissingKeyVersions = new Set(keysToCheck)
        const hasMissingKey = keysToCheck.some(k => !hasVaultKey(k))
        if (hasMissingKey) {
          try {
            await syncKeyringFromServer(currentAccountId)
            result = await reloadKeyringFromStorage()
          } catch (err) {
            log.warn('Failed to sync keyring from server:', err)
          }
        }
        const syncApi = this.lifecycleManager.getSyncApi()
        if (result.success && result.keyringData && syncApi) {
          await syncApi.updateVaultKey(result.keyringData)
        }
        // Versions still missing stay pending, for the next keyring update (such as on reconnect) to retry
        for (const k of this.pendingMissingKeyVersions) {
          if (hasVaultKey(k)) {
            this.pendingMissingKeyVersions.delete(k)
          }
        }
      })
    } while (kver && this.pendingMissingKeyVersions.has(kver) && !this.checkedMissingKeyVersions.has(kver))
  }

  private handleTokenRefresh = async () => {
    try {
      await handleSessionExpired()
      const token = getVaultSession() || null
      const syncApi = this.lifecycleManager.getSyncApi()
      if (syncApi) {
        await syncApi.updateAuthToken(token)
      }
    } catch (err) {
      log.error('Failed to handle token refresh:', err)
      const syncApi = this.lifecycleManager.getSyncApi()
      if (syncApi) {
        try {
          await syncApi.updateAuthToken(null)
        } catch {
          // Ignore
        }
      }
    }
  }

  requestClearOnShutdown(accountId?: string): void {
    this.lifecycleManager.requestClearOnShutdown(accountId)
  }

  isClearingLocalData(): boolean {
    return this.lifecycleManager.isClearingLocalData()
  }

  async ensureReady(): Promise<void> {
    await this.lifecycleManager.ensureReady()
  }

  initialize(accountId: string, options?: { clearLocalData?: boolean }): Promise<void> {
    this.telemetry.setUser(accountId)
    this.telemetry.setTag('accountId', accountId)
    return this.lifecycleManager.initialize(accountId, options)
  }

  async shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }): Promise<void> {
    await this.keyringUpdateGuard.waitForRunning()
    return this.lifecycleManager.shutdown(options)
  }

  private async execute<T>(fn: (api: Comlink.Remote<SyncApi>) => Promise<T>): Promise<T> {
    const api = await this.lifecycleManager.ensureReady()
    return fn(api)
  }

  /** Calls the worker's method of the same name once it's ready */
  private forward<K extends keyof SyncApi>(name: K): SyncApi<TDoc, TMeta>[K] {
    const call = (...args: unknown[]) => this.execute(api => (api[name] as (...a: unknown[]) => Promise<unknown>)(...args))
    return call as SyncApi<TDoc, TMeta>[K]
  }

  readonly mutateItem = this.forward('mutateItem')
  readonly createItem = this.forward('createItem')
  readonly storeItems = this.forward('storeItems')
  readonly mutateMetadata = this.forward('mutateMetadata')
  readonly exportAllBinaries = this.forward('exportAllBinaries')
  readonly flushSync = this.forward('flushSync')
  readonly fullResync = this.forward('fullResync')
  readonly pushSnapshots = this.forward('pushSnapshots')
  readonly retrySave = this.forward('retrySave')
  readonly checkDataVersion = this.forward('checkDataVersion')
  readonly retryRecoveryItem = this.forward('retryRecoveryItem')
  readonly replaceFromServer = this.forward('replaceFromServer')
  readonly forceOverwriteRecoveryItem = this.forward('forceOverwriteRecoveryItem')
  readonly forceDeleteRecoveryItem = this.forward('forceDeleteRecoveryItem')
  readonly recreateOversizedItem = this.forward('recreateOversizedItem')
  readonly dismissRecoveryItem = this.forward('dismissRecoveryItem')
  readonly updateVaultKey = this.forward('updateVaultKey')
  readonly exportSyncState = this.forward('exportSyncState')
  readonly restoreSyncState = this.forward('restoreSyncState')
  readonly claimLeader = this.forward('claimLeader')

  listRecoveryItems(options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    return this.execute(async api => {
      const entries = await api.listRecoveryItems(options)
      this.eventProcessor.setRecoveryEntries(entries)
      return entries
    })
  }

  subscribeRecoveryItems(listener: (entries: ManualRecoveryEntry[]) => void): () => void {
    return this.eventProcessor.subscribeRecoveryItems(listener)
  }

  restoreFromBinaries(documents: Partial<Record<string, string>>): Promise<string[]> {
    return this.execute(async api => {
      const result = await api.restoreFromBinaries(documents)
      this.sink.onDataRestored?.()
      return result
    })
  }

  /**
   * Deletes this device's local data for the account and starts sync again, which downloads it from
   * the server. Changes that weren't pushed are lost: only call this once the user has confirmed.
   */
  async discardLocalDataAndRestart(accountId: string): Promise<void> {
    this.localDataFailures.delete(accountId)
    await this.shutdown({ clearLocalData: true, accountId })
    await this.initialize(accountId)
  }

  reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<ReencryptResult> {
    return this.execute(async api => {
      const unsubscribe = onProgress
        ? this.eventProcessor.subscribeReencryptProgress(onProgress)
        : undefined
      try {
        return await api.reencryptAllItems()
      } finally {
        unsubscribe?.()
      }
    })
  }
}

export function createSyncBridge<TDoc extends VaultDoc, TMeta extends VaultMetadata>(
  options: SyncBridgeOptions<TDoc, TMeta>,
): SyncBridgeService<TDoc, TMeta> {
  return new SyncBridgeService(options)
}

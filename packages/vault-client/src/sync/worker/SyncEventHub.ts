import type { MigrationRequiredReason, SyncStatus, VaultDoc, VaultMetadata } from '../shared/types'
import type { ItemId } from '@vault/shared'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { createLogger, type Logger } from '../utils/logger'

export type ClientEvent =
  | { type: 'ready' }
  | { type: 'statusChange'; status: SyncStatus }
  | { type: 'itemUpdated'; id: string; item: VaultDoc | null }
  | { type: 'indexUpdated'; itemIds: ItemId[] }
  | { type: 'metadataUpdated'; metadata: VaultMetadata }
  | { type: 'mutationFailed'; mutationType: string; error: string }
  | { type: 'startRequest' }
  | { type: 'finishRequest' }
  | { type: 'authFailure'; message: string }
  | { type: 'recoveryItemsChanged'; entries: ManualRecoveryEntry[] }
  | { type: 'quotaExceeded'; message: string }
  | { type: 'quotaResolved' }
  | { type: 'keyVersionMissing'; kver: string }
  | { type: 'snapshotFailed'; itemId: ItemId; message: string }
  | { type: 'leaderConflict'; hasConflict: boolean }
  | { type: 'tokenRefreshNeeded' }
  | { type: 'reencryptProgress'; done: number; total: number }
  | { type: 'migrationRequired'; reason: MigrationRequiredReason }
  /** The worker is about to delete the plaintext stores the sealed ones replaced (see LocalEncryptionUpgrade) */
  | { type: 'retiringLegacyStores'; accountId: string }
  /** This device's local data can't be opened. `kver` is the missing key version, if that's the cause. */
  | { type: 'localDataUnavailable'; kver?: string; unpushedChanges: number }
  | {
    type: 'workerError'
    error: {
      message: string
      stack?: string
      name?: string
    }
  }

type EventListener<T> = (event: T) => void | Promise<void>

export class EventHub<T> {
  protected listeners = new Set<EventListener<T>>()
  protected readonly hubName: string
  protected readonly listenerDescription: string
  protected readonly log: Logger

  constructor(hubName = 'EventHub', listenerDescription = 'listener') {
    this.hubName = hubName
    this.listenerDescription = listenerDescription
    this.log = createLogger(hubName)
  }

  subscribe(listener: EventListener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Synchronously dispatches an event to all registered listeners.
   *
   * Error handling & execution semantics:
   * - Listener isolation: Synchronous errors thrown by a listener are caught and
   *   logged without aborting dispatch to subsequent listeners.
   * - Asynchronous listeners: Handlers returning a Promise run detached (fire-and-forget).
   *   Rejections are caught and logged asynchronously to prevent unhandled promise
   *   rejections, but they do NOT block execution.
   *
   * @param event The event payload to dispatch.
   */
  emit(event: T): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err =>
            this.log.error(`Error in ${this.listenerDescription}:`, err)
          )
        }
      } catch (err) {
        this.log.error(`Error in ${this.listenerDescription}:`, err)
      }
    }
  }
}

export class ClientEventHub extends EventHub<ClientEvent> {
  private externalPort: MessagePort | null = null

  constructor() {
    super('ClientEventHub', 'local listener')
  }

  setExternalPort(port: MessagePort | null): void {
    this.externalPort = port
  }

  /**
   * Dispatches the event locally and forwards it to the main thread via the external MessagePort if configured.
   *
   * @param event The client event to dispatch.
   */
  override emit(event: ClientEvent): void {
    super.emit(event)

    // Distribute to main-thread listener via MessagePort
    if (this.externalPort) {
      try {
        this.externalPort.postMessage(event)
      } catch (err) {
        this.log.error('Error posting to external port:', err)
      }
    }
  }
}

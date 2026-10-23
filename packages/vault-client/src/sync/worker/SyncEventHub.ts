import type { MigrationRequiredReason, SyncStatus, VaultDoc, VaultMetadata } from '../shared/types'
import type { ItemId } from '@vault/shared'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { PollOutcome } from './SyncPoller'

import type { DocumentId, Message, DocHandle } from '@automerge/automerge-repo/slim'
import type { RepoDoc } from './docStore/AutomergeDocStore'
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

export type WorkerInternalEvent =
  | { type: 'pollResult'; outcome: PollOutcome }
  | { type: 'multipleLeadersDetected' }
  | { type: 'soleLeaderRestored' }
  | { type: 'leaderConflict'; hasConflict: boolean }
  | { type: 'flushNeeded' }
  | { type: 'itemMessageParsed'; itemId: ItemId }
  | { type: 'remoteMessagesParsed'; itemId: ItemId }
  | { type: 'walAppendFailed'; itemId: ItemId; error: unknown }
  | { type: 'walEntriesPruned'; itemIds: ItemId[] }
  | { type: 'snapshotFallbackRequested'; itemId: ItemId }
  | { type: 'messageParsed'; itemId: ItemId; documentId: DocumentId; message: Uint8Array }
  | { type: 'decryptionFailure'; itemId: ItemId; error: unknown }
  /** A record in this device's sealed storage failed to decrypt */
  | { type: 'localDecryptionFailed'; itemId: ItemId; error: unknown }
  | { type: 'retryingStateChange'; isRetrying: boolean }
  | { type: 'keyVersionMissing'; kver: string }
  | { type: 'pendingPullsAvailable' }
  | { type: 'pushAcknowledged'; itemId: ItemId; heads: string[] }
  | { type: 'leaderChange'; isLeader: boolean }
  | { type: 'renegotiationTriggered'; documentId: DocumentId }
  | { type: 'messageToSend'; message: Message }
  | { type: 'docHandleReplaced'; itemId: ItemId; handle: DocHandle<RepoDoc> }

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
   *   rejections, but they do NOT block execution or affect the returned boolean.
   *
   * @param event The event payload to dispatch.
   * @returns `true` if all listeners were invoked without throwing synchronous errors;
   *          `false` if any listener threw synchronously.
   */
  emit(event: T): boolean {
    let hasError = false
    for (const listener of Array.from(this.listeners)) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err =>
            this.log.error(`Error in ${this.listenerDescription}:`, err)
          )
        }
      } catch (err) {
        hasError = true
        this.log.error(`Error in ${this.listenerDescription}:`, err)
      }
    }
    return !hasError
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
   * @returns `true` if local listeners and external port transfer succeeded without synchronous error; `false` otherwise.
   */
  override emit(event: ClientEvent): boolean {
    const ok = super.emit(event)

    // Distribute to main-thread listener via MessagePort
    if (this.externalPort) {
      try {
        this.externalPort.postMessage(event)
      } catch (err) {
        this.log.error('Error posting to external port:', err)
        return false
      }
    }
    return ok
  }
}

export class WorkerInternalEventHub extends EventHub<WorkerInternalEvent> {
  constructor() {
    super('WorkerInternalEventHub', 'listener')
  }
}


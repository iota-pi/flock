import type { SyncStatus } from 'src/state/slices/syncSlice'
import type { Item } from 'src/state/items'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { PollOutcome } from './SyncPoller'

import type { DocumentId, Message, DocHandle } from '@automerge/automerge-repo/slim'
import type { RepoDoc } from './docStore/AutomergeDocStore'

export type ClientEvent =
  | { type: 'ready' }
  | { type: 'statusChange'; status: SyncStatus }
  | { type: 'itemUpdated'; id: string; item: Item | null }
  | { type: 'indexUpdated'; itemIds: ItemId[] }
  | { type: 'metadataUpdated'; metadata: AccountMetadata }
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

export type WorkerInternalEvent =
  | { type: 'pollResult'; outcome: PollOutcome }
  | { type: 'multipleLeadersDetected' }
  | { type: 'soleLeaderRestored' }
  | { type: 'leaderConflict'; hasConflict: boolean }
  | { type: 'flushNeeded' }
  | { type: 'itemMessageParsed'; itemId: ItemId }
  | { type: 'walAppendFailed'; itemId: ItemId; error: unknown }
  | { type: 'walEntriesPruned'; itemIds: ItemId[] }
  | { type: 'messageParsed'; itemId: ItemId; documentId: DocumentId; message: Uint8Array }
  | { type: 'decryptionFailure'; itemId: ItemId; error: unknown }
  | { type: 'retryingStateChange'; isRetrying: boolean }
  | { type: 'keyVersionMissing'; kver: string }
  | { type: 'pendingPullsAvailable' }
  | { type: 'pushAcknowledged'; itemId: ItemId; heads: string[] }
  | { type: 'leaderChange'; isLeader: boolean }
  | { type: 'renegotiationTriggered'; documentId: DocumentId }
  | { type: 'messageToSend'; message: Message }
  | { type: 'docHandleReplaced'; itemId: ItemId; handle: DocHandle<RepoDoc> }

export type EventListener<T> = (event: T) => void | Promise<void>
export type ClientEventListener = EventListener<ClientEvent>
export type WorkerInternalEventListener = EventListener<WorkerInternalEvent>

export class EventHub<T> {
  protected listeners = new Set<EventListener<T>>()
  protected readonly hubName: string
  protected readonly listenerDescription: string

  constructor(hubName = 'EventHub', listenerDescription = 'listener') {
    this.hubName = hubName
    this.listenerDescription = listenerDescription
  }

  subscribe(listener: EventListener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: T): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err =>
            console.error(`[${this.hubName}] Error in ${this.listenerDescription}:`, err)
          )
        }
      } catch (err) {
        console.error(`[${this.hubName}] Error in ${this.listenerDescription}:`, err)
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

  override emit(event: ClientEvent): void {
    super.emit(event)

    // Distribute to main-thread listener via MessagePort
    if (this.externalPort) {
      try {
        this.externalPort.postMessage(event)
      } catch (err) {
        console.error('[ClientEventHub] Error posting to external port:', err)
      }
    }
  }
}

export class WorkerInternalEventHub extends EventHub<WorkerInternalEvent> {
  constructor() {
    super('WorkerInternalEventHub', 'listener')
  }
}



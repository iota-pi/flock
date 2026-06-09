import type { SyncStatus } from 'src/state/syncStore'
import type { Item } from 'src/state/items'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { PollOutcome } from './SyncPoller'

export type ClientEvent =
  | { type: 'ready' }
  | { type: 'statusChange'; status: SyncStatus }
  | { type: 'itemUpdated'; id: string; item: Item | null }
  | { type: 'indexUpdated'; itemIds: ItemId[] }
  | { type: 'metadataUpdated'; metadata: AccountMetadata }
  | { type: 'mutationFailed'; mutationId: string; error: string }
  | { type: 'startRequest' }
  | { type: 'finishRequest' }
  | { type: 'authFailure'; message: string }
  | { type: 'recoveryItemsChanged'; entries: ManualRecoveryEntry[] }
  | { type: 'quotaExceeded'; message: string }

export type WorkerInternalEvent =
  | { type: 'snapshotNeeded'; cursor: number; requestedAt: number }
  | { type: 'pollResult'; outcome: PollOutcome }

export type ClientEventListener = (event: ClientEvent) => void | Promise<void>
export type WorkerInternalEventListener = (event: WorkerInternalEvent) => void | Promise<void>

export class ClientEventHub {
  private listeners = new Set<ClientEventListener>()
  private externalListener: ClientEventListener | null = null

  subscribe(listener: ClientEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setExternalListener(listener: ClientEventListener | null): void {
    this.externalListener = listener
  }

  emit(event: ClientEvent): void {
    // Distribute to local subscribers
    for (const listener of this.listeners) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('[ClientEventHub] Error in local listener:', err))
        }
      } catch (err) {
        console.error('[ClientEventHub] Error in local listener:', err)
      }
    }

    // Distribute to main-thread listener
    if (this.externalListener) {
      try {
        const result = this.externalListener(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('[ClientEventHub] Error in external listener:', err))
        }
      } catch (err) {
        console.error('[ClientEventHub] Error in external listener:', err)
      }
    }
  }
}

export class WorkerInternalEventHub {
  private listeners = new Set<WorkerInternalEventListener>()

  subscribe(listener: WorkerInternalEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: WorkerInternalEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('[WorkerInternalEventHub] Error in listener:', err))
        }
      } catch (err) {
        console.error('[WorkerInternalEventHub] Error in listener:', err)
      }
    }
  }
}


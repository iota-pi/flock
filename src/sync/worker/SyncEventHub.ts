import type { SyncStatus } from 'src/state/syncStore'
import type { Item } from 'src/state/items'
import type { ItemId } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { PollOutcome } from './SyncPoller'

export type SyncEvent =
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
  | { type: 'snapshotNeeded'; cursor: number; requestedAt: number }
  | { type: 'pollResult'; outcome: PollOutcome }

export type SyncEventListener = (event: SyncEvent) => void | Promise<void>

export class SyncEventHub {
  private listeners = new Set<SyncEventListener>()
  private externalListener: SyncEventListener | null = null

  subscribe(listener: SyncEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setExternalListener(listener: SyncEventListener | null): void {
    this.externalListener = listener
  }

  emit(event: SyncEvent): void {
    // Distribute to local subscribers
    for (const listener of this.listeners) {
      try {
        const result = listener(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('[SyncEventHub] Error in local listener:', err))
        }
      } catch (err) {
        console.error('[SyncEventHub] Error in local listener:', err)
      }
    }

    // Distribute to main-thread listener (filter internal-only events)
    if (this.externalListener && event.type !== 'snapshotNeeded' && event.type !== 'pollResult') {
      try {
        const result = this.externalListener(event)
        if (result instanceof Promise) {
          result.catch(err => console.error('[SyncEventHub] Error in external listener:', err))
        }
      } catch (err) {
        console.error('[SyncEventHub] Error in external listener:', err)
      }
    }
  }
}

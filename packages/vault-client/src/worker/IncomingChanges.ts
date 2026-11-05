import type { ItemId } from '@vault/shared'
import type { AutomergeDocStore } from './docStore'
import type { ChangeOutbox } from './ChangeOutbox'
import type { ServerHeads } from './ServerHeads'
import { areHeadsEqual } from './utils/automerge'

export interface IncomingChangesDeps {
  docStore: Pick<AutomergeDocStore, 'applyIncomingChanges'>
  outbox: Pick<ChangeOutbox, 'isPending'>
  serverHeads: ServerHeads
  /** Called for each item log changes were applied to, so the app sees a new document */
  onItemApplied: (itemId: ItemId) => void
  /** Called with an item whose doc gained changes it didn't have */
  onChangesAdded: (itemId: ItemId) => void
}

/** Applies decrypted log rows to docs, for the puller and for the gap healer's retries */
export class IncomingChanges {
  constructor(private readonly deps: IncomingChangesDeps) {}

  /**
   * Applies a row. Returns false when its dependencies are missing, and nothing was stored for an
   * unloaded doc. Applying never marks an item pending.
   *
   * Server heads follow the doc only if the doc matched them before these changes. Otherwise it held
   * changes of its own, which its mark may not have reached storage to say, so they'd never be pushed.
   */
  async apply(itemId: ItemId, bytes: Uint8Array): Promise<boolean> {
    const isPending = await this.deps.outbox.isPending(itemId)
    const result = await this.deps.docStore.applyIncomingChanges(itemId, bytes, ({ headsBefore, headsAfter }) => {
      if (isPending || !headsBefore || !areHeadsEqual(headsBefore, this.deps.serverHeads.get(itemId))) return
      this.deps.serverHeads.set(itemId, headsAfter)
    })
    if (result.status === 'missingDeps') return false

    this.deps.onItemApplied(itemId)
    if (result.addedChanges) {
      this.deps.onChangesAdded(itemId)
    }
    return true
  }
}

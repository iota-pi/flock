import { chunk, debounce } from 'lodash-es'
import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId, type SyncLogMessage } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
import type { ServerHeads } from './ServerHeads'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import type { SyncSessionState } from './SyncSessionState'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_BATCH_SIZES, SYNC_TIMEOUTS } from '../shared/syncConfig'
import { checkAlive } from '../utils/abort'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ChangeOutbox')

/** An item's pending mark. A new mark gets a new tick, so a push never clears an edit it didn't send. */
interface PendingMark {
  itemId: ItemId
  tick: number
}

export function createPendingMark(itemId: ItemId): PendingMark {
  return { itemId, tick: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) }
}

/** One item's outgoing rows, and what to record once the server has acknowledged every one */
interface PreparedPush {
  itemId: ItemId
  /** The tick the mark had before the changes were read */
  tick: number | undefined
  heads: string[]
  messages: SyncLogMessage[]
}

export interface LogPushResult {
  itemId: ItemId
  seq: number
}

/**
 * Sends messages in one `pollLog` and handles the log it reads. `onResults` runs before the entries
 * are applied, so a pull sees the state the acknowledgement leaves.
 */
export type LogExchange = (
  push: SyncLogMessage[],
  onResults: (results: LogPushResult[]) => Promise<void>,
  signal?: AbortSignal,
) => Promise<void>

export interface ChangeOutboxDeps {
  db: SyncLogDatabase
  docStore: Pick<AutomergeDocStore, 'readChangesSince' | 'hasChangesSince' | 'hasDataInStorage'>
  keys: KeyProvider
  session: SyncSessionState
  serverHeads: ServerHeads
  /** Whether an item waits on first start, so its server heads aren't known and it can't be pushed */
  isAwaitingFirstStart: (itemId: ItemId) => boolean
  /** Whether first start has got far enough for anything to reach the log */
  canPush: () => boolean
  exchange: LogExchange
  /** Asks for an item's snapshot now, which delivers what the log can't */
  requestSnapshot: (itemId: ItemId) => void
  /** Called once a mark is written, so the leader pushes and the unsynced count updates */
  onMarked: () => void
}

function byteLength(chunks: Uint8Array[]): number {
  return chunks.reduce((total, part) => total + part.byteLength, 0)
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(byteLength(chunks))
  let offset = 0
  for (const part of chunks) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

/** Groups changes, in order, into runs of at most `MAX_INCREMENTAL_MESSAGE_BYTES` */
function groupIntoRows(changes: Uint8Array[]): Uint8Array[] {
  const rows: Uint8Array[][] = []
  let current: Uint8Array[] = []
  let size = 0
  for (const change of changes) {
    if (current.length > 0 && size + change.byteLength > MAX_INCREMENTAL_MESSAGE_BYTES) {
      rows.push(current)
      current = []
      size = 0
    }
    current.push(change)
    size += change.byteLength
  }
  if (current.length > 0) rows.push(current)
  return rows.map(concatenate)
}

/** Splits rows, in order, into requests the server can append in one transaction */
function packRequests(messages: SyncLogMessage[]): SyncLogMessage[][] {
  const requests: SyncLogMessage[][] = []
  let current: SyncLogMessage[] = []
  let chars = 0
  for (const message of messages) {
    const size = message.encryptedMessage.cipher.length
    const isFull = current.length >= SYNC_BATCH_SIZES.logPushRows || chars + size > SYNC_BATCH_SIZES.logPushChars
    if (current.length > 0 && isFull) {
      requests.push(current)
      current = []
      chars = 0
    }
    current.push(message)
    chars += size
  }
  if (current.length > 0) requests.push(current)
  return requests
}

/**
 * Tracks which items may have changes the server lacks, and pushes them from the doc. The doc stays
 * the only copy of a change (sync rule 1), so nothing here can lose one: a failure before the server
 * acknowledges a push changes nothing, and the next push reads the same changes again.
 *
 * A pending mark is a hint. A false one costs an empty check at push time.
 */
export class ChangeOutbox {
  /** Items with a single change too large for a row, which only a snapshot can deliver */
  private readonly snapshotOnlyItems = new Set<ItemId>()
  private readonly changedItems = new Set<ItemId>()

  private readonly checkChangedItemsDebounced = debounce(
    () => fireAndForget(this.checkChangedItems(), 'ChangeOutbox:checkChangedItems'),
    SYNC_TIMEOUTS.docChangeCheck,
  )

  constructor(private readonly deps: ChangeOutboxDeps) {}

  /** Records that an item has changes to push. Every tab writes marks, so an edit outlives the leader. */
  async mark(itemId: ItemId): Promise<void> {
    if (this.deps.session.isShutdown) return
    await this.deps.db.put(SYNC_LOG_STORES.outbox, createPendingMark(itemId))
    this.deps.onMarked()
  }

  async markAll(itemIds: ItemId[]): Promise<void> {
    if (itemIds.length === 0 || this.deps.session.isShutdown) return
    await this.deps.db.put(SYNC_LOG_STORES.outbox, ...itemIds.map(createPendingMark))
    this.deps.onMarked()
  }

  async listPending(): Promise<ItemId[]> {
    const marks = await this.deps.db.getAll<PendingMark>(SYNC_LOG_STORES.outbox)
    return marks.map(mark => mark.itemId)
  }

  async isPending(itemId: ItemId): Promise<boolean> {
    return await this.deps.db.get<PendingMark>(SYNC_LOG_STORES.outbox, itemId) !== undefined
  }

  /** Whether only a snapshot can deliver the item's changes, so snapshot coverage lets it through */
  isSnapshotOnly(itemId: ItemId): boolean {
    return this.snapshotOnlyItems.has(itemId)
  }

  /** Records a stored snapshot that carried what the log couldn't, which puts the server at its heads */
  confirmSnapshotOnly(itemId: ItemId, heads: string[] | undefined): void {
    if (!this.snapshotOnlyItems.delete(itemId)) return
    if (heads && heads.length > 0) {
      this.deps.serverHeads.set(itemId, heads)
    }
  }

  private async clearMark(itemId: ItemId, tick: number | undefined): Promise<void> {
    if (tick === undefined) return
    await this.deps.db.deleteIf<PendingMark>(SYNC_LOG_STORES.outbox, itemId, mark => mark.tick === tick)
  }

  /**
   * Called when an item's doc changes, whatever changed it. Changes from a follower reach the leader
   * after its mark, which a push may already have cleared, so the leader marks what it finds unpushed.
   */
  onDocChanged(itemId: ItemId): void {
    if (!this.deps.session.isLeader) return
    this.changedItems.add(itemId)
    this.checkChangedItemsDebounced()
  }

  private async checkChangedItems(): Promise<void> {
    const itemIds = Array.from(this.changedItems)
    this.changedItems.clear()
    if (!this.deps.session.isLeader || this.deps.session.isShutdown) return

    const unpushed = itemIds.filter(itemId => (
      !this.deps.isAwaitingFirstStart(itemId)
      && this.deps.docStore.hasChangesSince(itemId, this.deps.serverHeads.get(itemId))
    ))
    if (unpushed.length === 0) return
    const pending = new Set(await this.listPending())
    await this.markAll(unpushed.filter(itemId => !pending.has(itemId)))
  }

  /** Pushes every item with a pending mark */
  async pushPending(signal?: AbortSignal): Promise<void> {
    await this.pushItems(await this.listPending(), signal)
  }

  /**
   * Pushes what the given items have after their server heads, a few items at a time. Does nothing
   * until first start allows it. Throws if a push fails, leaving the rest for the next one.
   */
  async pushItems(itemIds: ItemId[], signal?: AbortSignal): Promise<void> {
    if (itemIds.length === 0 || !this.deps.canPush()) return
    const marks = await this.deps.db.getAll<PendingMark>(SYNC_LOG_STORES.outbox)
    const ticks = new Map(marks.map(mark => [mark.itemId, mark.tick]))

    for (const group of chunk(itemIds, SYNC_BATCH_SIZES.pollChunk)) {
      checkAlive(signal, () => !this.deps.session.isShutdown)
      const prepared: PreparedPush[] = []
      for (const itemId of group) {
        const push = await this.preparePush(itemId, ticks.get(itemId))
        if (push) prepared.push(push)
      }
      await this.send(prepared, signal)
    }
  }

  /** Reads and encrypts an item's outgoing rows. Returns null when there's nothing to send. */
  private async preparePush(itemId: ItemId, tick: number | undefined): Promise<PreparedPush | null> {
    if (this.deps.isAwaitingFirstStart(itemId) || this.snapshotOnlyItems.has(itemId)) return null

    const outgoing = await this.deps.docStore.readChangesSince(itemId, this.deps.serverHeads.get(itemId))
    if (!outgoing) {
      // A doc that exists but won't load keeps its mark, and so do its unpushed changes
      if (!await this.deps.docStore.hasDataInStorage(itemId)) {
        await this.clearMark(itemId, tick)
      }
      return null
    }

    if (outgoing.changes.length === 0) {
      await this.clearMark(itemId, tick)
      return null
    }

    if (outgoing.changes.some(change => change.byteLength > MAX_INCREMENTAL_MESSAGE_BYTES)) {
      log.warn(`A change to item ${itemId} is over the row limit; delivering it with a snapshot`)
      this.snapshotOnlyItems.add(itemId)
      this.deps.requestSnapshot(itemId)
      return null
    }

    const messages = await Promise.all(groupIntoRows(outgoing.changes).map(async row => ({
      itemId,
      encryptedMessage: await this.deps.keys.encryptBytes(row, itemId),
    })))
    return { itemId, tick, heads: outgoing.heads, messages }
  }

  /** Sends the prepared rows and records each item the server acknowledged in full */
  private async send(prepared: PreparedPush[], signal?: AbortSignal): Promise<void> {
    if (prepared.length === 0) return
    const unacknowledged = new Map(prepared.map(push => [push.itemId, push.messages.length]))
    const pushesByItem = new Map(prepared.map(push => [push.itemId, push]))

    for (const request of packRequests(prepared.flatMap(push => push.messages))) {
      await this.deps.exchange(request, async results => {
        const finished: PreparedPush[] = []
        for (const { itemId } of results) {
          const remaining = (unacknowledged.get(itemId) ?? 0) - 1
          unacknowledged.set(itemId, remaining)
          const push = pushesByItem.get(itemId)
          if (remaining === 0 && push) finished.push(push)
        }
        await this.recordAcknowledged(finished)
      }, signal)
    }

    const unconfirmed = Array.from(unacknowledged.values()).filter(remaining => remaining > 0).length
    if (unconfirmed > 0) {
      throw new Error(`The server didn't acknowledge every row of ${unconfirmed} items`)
    }
  }

  /** Heads are saved before marks clear, so a crash between the two resends rather than forgets */
  private async recordAcknowledged(pushes: PreparedPush[]): Promise<void> {
    if (pushes.length === 0) return
    for (const { itemId, heads } of pushes) {
      this.deps.serverHeads.set(itemId, heads)
    }
    await this.deps.serverHeads.save()
    for (const { itemId, tick } of pushes) {
      await this.clearMark(itemId, tick)
    }
  }

  shutdown(): void {
    this.checkChangedItemsDebounced.cancel()
    this.changedItems.clear()
    this.snapshotOnlyItems.clear()
  }
}

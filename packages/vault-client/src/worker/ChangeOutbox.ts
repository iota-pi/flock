import { debounce } from 'lodash-es'
import { MAX_INCREMENTAL_MESSAGE_BYTES, type ItemId, type SyncLogMessage } from '@vault/shared'
import type { KeyProvider } from '../keys/Keyring'
import type { AutomergeDocStore } from './docStore'
import type { ItemSyncState } from './ItemSyncState'
import type { LogExchange } from './LogExchange'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import type { SyncSessionState } from './SyncSessionState'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_BATCH_SIZES, SYNC_TIMEOUTS } from '../shared/syncConfig'
import { checkAlive } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ChangeOutbox')

/** Statuses for a request the server refuses as it stands, which sending it again won't change */
const REFUSED_REQUEST_STATUSES = new Set([400, 413, 422])

/** Whether the server refused a push for what it holds, rather than for the session or an outage */
function isRefusedRequest(error: unknown): boolean {
  const { status } = classifySyncError(error)
  return status !== undefined && REFUSED_REQUEST_STATUSES.has(status)
}

/** Why the leader's last push skipped an item, which only it can tell */
export type PendingBlockReason = 'snapshotOnly' | 'unloadable'

/** An item's pending mark. A new mark gets a new tick, so a push never clears an edit it didn't send. */
export interface PendingMark {
  itemId: ItemId
  tick: number
  /**
   * When the item first had changes waiting, kept by later marks, so an item that stays stuck shows
   * its age however often it's edited. The migration app dates marks from builds before it existed
   * (`datePendingMarks`).
   */
  createdAt: number
  /** Why the leader's last push skipped the item, kept on the mark so every tab can count it */
  blocked?: PendingBlockReason
}

function createTick(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

export function createPendingMark(itemId: ItemId, createdAt = Date.now()): PendingMark {
  return { itemId, tick: createTick(), createdAt }
}

/** One item's outgoing rows, and what to record once the server has acknowledged every one */
interface PreparedPush {
  itemId: ItemId
  /** The tick the mark had before the changes were read */
  tick: number | undefined
  heads: string[]
  messages: SyncLogMessage[]
}

/** Reads which items have pending marks */
export type PendingMarkReader = Pick<ChangeOutbox, 'isPending' | 'listPending'>

/** Reads pending marks straight from the outbox store, for a component built before the outbox */
export function readPendingMarks(db: Pick<SyncLogDatabase, 'get' | 'getAll'>): PendingMarkReader {
  return {
    isPending: async itemId => await db.get<PendingMark>(SYNC_LOG_STORES.outbox, itemId) !== undefined,
    listPending: async () => (await db.getAll<PendingMark>(SYNC_LOG_STORES.outbox)).map(mark => mark.itemId),
  }
}

export interface LogPushResult {
  itemId: ItemId
  seq: number
}

export interface ChangeOutboxDeps {
  db: SyncLogDatabase
  docStore: Pick<AutomergeDocStore, 'readChangesSince' | 'hasChangesSince' | 'hasDataInStorage'>
  keys: KeyProvider
  session: SyncSessionState
  /** Each item's server heads and whether only a snapshot can deliver it */
  itemSyncState: Pick<
    ItemSyncState,
    'getServerHeads' | 'setServerHeads' | 'isSnapshotOnly' | 'setSnapshotOnly' | 'save' | 'requestSave' | 'hasUnsaved'
  >
  /** Sends messages in one `pollLog` and handles the log it reads (see LogExchange) */
  exchange: LogExchange['exchange']
  /** Asks for an item's snapshot now, which delivers what the log can't */
  requestSnapshot: (itemId: ItemId) => void
  /**
   * Called once a mark is written, or the leader finds unpushed changes on an item already marked, so
   * the leader pushes and the unsynced count updates
   */
  onMarked: () => void
  /**
   * Called for each item whose push the server acknowledged in full, before the acknowledgement is
   * saved, so the item owes a snapshot and its dirty flag goes in the same save as its server heads
   */
  onAcknowledged: (itemId: ItemId) => void
  now?: () => number
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

function messageChars(messages: SyncLogMessage[]): number {
  return messages.reduce((total, message) => total + message.encryptedMessage.cipher.length, 0)
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
  private readonly changedItems = new Set<ItemId>()

  private readonly checkChangedItemsDebounced = debounce(
    () => fireAndForget(this.checkChangedItems(), 'ChangeOutbox:checkChangedItems'),
    SYNC_TIMEOUTS.docChangeCheck,
  )

  constructor(private readonly deps: ChangeOutboxDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Records that an item has changes to push. Every tab writes marks, so an edit outlives the leader. */
  async mark(itemId: ItemId): Promise<void> {
    await this.markAll([itemId])
  }

  /** Gives each item a new mark, keeping when an existing one first had changes waiting */
  async markAll(itemIds: ItemId[]): Promise<void> {
    if (itemIds.length === 0 || this.deps.session.isShutdown) return
    const now = this.now()
    await this.deps.db.update<PendingMark>(SYNC_LOG_STORES.outbox, itemIds, (current, key) => ({
      ...current,
      itemId: key as ItemId,
      tick: createTick(),
      createdAt: current ? current.createdAt : now,
    }))
    this.deps.onMarked()
  }

  async listPending(): Promise<ItemId[]> {
    const marks = await this.listMarks()
    return marks.map(mark => mark.itemId)
  }

  async listMarks(): Promise<PendingMark[]> {
    return this.deps.db.getAll<PendingMark>(SYNC_LOG_STORES.outbox)
  }

  async isPending(itemId: ItemId): Promise<boolean> {
    return await this.deps.db.get<PendingMark>(SYNC_LOG_STORES.outbox, itemId) !== undefined
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
      this.deps.docStore.hasChangesSince(itemId, this.deps.itemSyncState.getServerHeads(itemId))
    ))
    if (unpushed.length === 0) return
    const pending = new Set(await this.listPending())
    const unmarked = unpushed.filter(itemId => !pending.has(itemId))
    if (unmarked.length > 0) {
      await this.markAll(unmarked)
    } else if (!this.deps.session.isShutdown) {
      // A follower's edit is marked before its change reaches this tab, so nothing woke the push
      this.deps.onMarked()
    }
  }

  /** Pushes every item with a pending mark */
  async pushPending(signal?: AbortSignal): Promise<void> {
    await this.pushItems(await this.listPending(), signal)
  }

  /**
   * Pushes what the given items have after their server heads, preparing items until the next would
   * overfill a request, so each request carries as many items as one transaction can. Throws if a
   * push fails, leaving the rest for the next one.
   */
  async pushItems(itemIds: ItemId[], signal?: AbortSignal): Promise<void> {
    if (itemIds.length === 0) return
    const marks = await this.listMarks()
    const marksById = new Map(marks.map(mark => [mark.itemId, mark]))

    let batch: PreparedPush[] = []
    let rows = 0
    let chars = 0
    for (const itemId of itemIds) {
      checkAlive(signal, () => !this.deps.session.isShutdown)
      const push = await this.preparePush(itemId, marksById.get(itemId))
      if (!push) continue
      const pushChars = messageChars(push.messages)
      const isFull = (
        rows + push.messages.length > SYNC_BATCH_SIZES.logPushRows
        || chars + pushChars > SYNC_BATCH_SIZES.logPushChars
      )
      if (batch.length > 0 && isFull) {
        await this.sendSettingAsideRefused(batch, signal)
        batch = []
        rows = 0
        chars = 0
      }
      batch.push(push)
      rows += push.messages.length
      chars += pushChars
    }
    await this.sendSettingAsideRefused(batch, signal)
  }

  /**
   * Sends the pushes, and if the server refuses the request itself, finds the items it refuses on
   * their own and delivers those by snapshot, as it does a change too large for a row. Otherwise one
   * such item would fail every push for good. Resending what an earlier request
   * stored only repeats changes, which Automerge ignores.
   */
  private async sendSettingAsideRefused(prepared: PreparedPush[], signal?: AbortSignal): Promise<void> {
    try {
      await this.send(prepared, signal)
    } catch (error) {
      if (!isRefusedRequest(error)) throw error
      if (prepared.length === 1) {
        const [{ itemId }] = prepared
        log.warn(`The server refused the log rows of item ${itemId}; delivering it with a snapshot`, error)
        this.deps.itemSyncState.setSnapshotOnly(itemId)
        this.deps.requestSnapshot(itemId)
        return
      }
      // A full request holds dozens of items, so halve it rather than resend them one at a time
      const half = Math.ceil(prepared.length / 2)
      await this.sendSettingAsideRefused(prepared.slice(0, half), signal)
      await this.sendSettingAsideRefused(prepared.slice(half), signal)
    }
  }

  /** Records why a push skipped the item, writing only when the reason changes */
  private async recordBlocked(mark: PendingMark | undefined, reason: PendingBlockReason): Promise<void> {
    if (!mark || mark.blocked === reason) return
    mark.blocked = reason
    await this.deps.db.update<PendingMark>(
      SYNC_LOG_STORES.outbox,
      [mark.itemId],
      current => (current ? { ...current, blocked: reason } : undefined),
    )
  }

  /** Reads and encrypts an item's outgoing rows. Returns null when there's nothing to send. */
  private async preparePush(itemId: ItemId, mark: PendingMark | undefined): Promise<PreparedPush | null> {
    if (this.deps.itemSyncState.isSnapshotOnly(itemId)) {
      await this.recordBlocked(mark, 'snapshotOnly')
      return null
    }

    const tick = mark?.tick
    const outgoing = await this.deps.docStore.readChangesSince(itemId, this.deps.itemSyncState.getServerHeads(itemId))
    if (!outgoing) {
      // A doc that exists but won't load keeps its mark, and so do its unpushed changes
      if (await this.deps.docStore.hasDataInStorage(itemId)) {
        await this.recordBlocked(mark, 'unloadable')
      } else {
        await this.clearMark(itemId, tick)
      }
      return null
    }

    if (outgoing.changes.length === 0) {
      // Server heads a failed save left unsaved would be lost in a crash, and the mark with them
      if (!this.deps.itemSyncState.hasUnsaved(itemId, 'serverHeads')) {
        await this.clearMark(itemId, tick)
      }
      return null
    }

    if (outgoing.changes.some(change => change.byteLength > MAX_INCREMENTAL_MESSAGE_BYTES)) {
      log.warn(`A change to item ${itemId} is over the row limit; delivering it with a snapshot`)
      this.deps.itemSyncState.setSnapshotOnly(itemId)
      this.deps.requestSnapshot(itemId)
      await this.recordBlocked(mark, 'snapshotOnly')
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

  /**
   * Records each item's new server heads and marks it dirty, so the leader uploads its snapshot, and
   * saves both in one transaction, before the marks clear: a crash between the two resends rather
   * than forgets. If the save fails the marks stay, and the save is retried. The heads stay unsaved
   * in memory, so the next push finds nothing to send but keeps the mark until they're saved
   * (`preparePush`), and the item stays queued for its snapshot in this session.
   */
  private async recordAcknowledged(pushes: PreparedPush[]): Promise<void> {
    if (pushes.length === 0) return
    for (const { itemId, heads } of pushes) {
      this.deps.itemSyncState.setServerHeads(itemId, heads)
      this.deps.onAcknowledged(itemId)
    }
    try {
      await this.deps.itemSyncState.save()
    } catch (error) {
      log.error('Failed to save server heads; keeping the pending marks', error)
      this.deps.itemSyncState.requestSave()
      return
    }
    for (const { itemId, tick } of pushes) {
      await this.clearMark(itemId, tick)
    }
  }

  shutdown(): void {
    this.checkChangedItemsDebounced.cancel()
    this.changedItems.clear()
  }
}

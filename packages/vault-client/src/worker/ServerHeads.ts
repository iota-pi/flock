import { debounce } from 'lodash-es'
import type { ItemId } from '@vault/shared'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import { readItemSyncRecords, updateItemSyncRecords } from './stores/itemSyncRecords'
import { areHeadsEqual } from './utils/automerge'
import { AsyncMutex } from '../utils/AsyncMutex'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ServerHeads')

const SAVE_DEBOUNCE_MS = 1000

/**
 * The heads of each item whose every ancestor is on the server, in the log or in the item's current
 * snapshot. Pushes send what the doc has after them. They're kept in each item's sync record. Only the
 * leader records them, but a tab that has just stopped leading can still save after the new leader
 * loaded, and heads loaded earlier may be older than the store, so a save writes only the items this
 * tab changed.
 */
export class ServerHeads {
  private readonly headsByItem = new Map<ItemId, string[]>()
  private readonly unsaved = new Set<ItemId>()
  private readonly saveMutex = new AsyncMutex()

  private readonly saveDebounced = debounce(
    () => fireAndForget(this.save(), 'ServerHeads:save'),
    SAVE_DEBOUNCE_MS,
  )

  constructor(private readonly db: Pick<SyncLogDatabase, 'getAll' | 'update'>) {}

  /** Loads the stored heads. Heads this tab hasn't saved yet stay. */
  async load(): Promise<void> {
    const records = await readItemSyncRecords(this.db)
    const kept = new Map(Array.from(this.unsaved, itemId => [itemId, this.get(itemId)]))
    this.headsByItem.clear()
    for (const { itemId, serverHeads } of records) {
      if (serverHeads) this.headsByItem.set(itemId, serverHeads)
    }
    for (const [itemId, heads] of kept) {
      this.headsByItem.set(itemId, heads)
    }
  }

  /** The item's server heads, empty when none are known */
  get(itemId: ItemId): string[] {
    return this.headsByItem.get(itemId) ?? []
  }

  has(itemId: ItemId): boolean {
    return this.headsByItem.has(itemId)
  }

  set(itemId: ItemId, heads: string[]): void {
    if (areHeadsEqual(this.headsByItem.get(itemId), heads)) return
    this.headsByItem.set(itemId, heads)
    this.unsaved.add(itemId)
    this.saveDebounced()
  }

  /** Saves changed heads now. A failure is logged: heads that are too old only resend changes. */
  async save(): Promise<void> {
    this.saveDebounced.cancel()
    await this.saveMutex.runExclusive(async () => {
      if (this.unsaved.size === 0) return
      const changed = Array.from(this.unsaved)
      this.unsaved.clear()
      try {
        await updateItemSyncRecords(this.db, changed, record => ({ ...record, serverHeads: this.get(record.itemId) }))
      } catch (error) {
        for (const itemId of changed) {
          this.unsaved.add(itemId)
        }
        log.error('Failed to save server heads', error)
      }
    })
  }

  /** Saves changed heads, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.saveDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.save()
    }
    this.headsByItem.clear()
    this.unsaved.clear()
  }
}

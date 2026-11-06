import { debounce } from 'lodash-es'
import type { ItemId } from '@vault/shared'
import type { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { areHeadsEqual } from './utils/automerge'
import { AsyncMutex } from '../utils/AsyncMutex'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ServerHeads')

const SAVE_DEBOUNCE_MS = 1000

/**
 * The heads of each item whose every ancestor is on the server, in the log or in the item's current
 * snapshot. Pushes send what the doc has after them. Every tab may record some (a follower can run a
 * manifest sync), and heads loaded earlier may be older than the store, so a save writes only what
 * this tab changed.
 */
export class ServerHeads {
  private readonly headsByItem = new Map<ItemId, string[]>()
  private readonly unsaved = new Set<ItemId>()
  private readonly saveMutex = new AsyncMutex()

  private readonly saveDebounced = debounce(
    () => fireAndForget(this.save(), 'ServerHeads:save'),
    SAVE_DEBOUNCE_MS,
  )

  constructor(private readonly store: Pick<SyncedHeadsStore, 'loadSyncedHeads' | 'saveSyncedHeads'>) {}

  /** Loads the stored heads. Heads this tab hasn't saved yet stay. */
  async load(): Promise<void> {
    const stored = await this.store.loadSyncedHeads()
    const kept = new Map(Array.from(this.unsaved, itemId => [itemId, this.get(itemId)]))
    this.headsByItem.clear()
    for (const [itemId, heads] of [...stored ?? [], ...kept]) {
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
        const merged = new Map(await this.store.loadSyncedHeads() ?? [])
        for (const itemId of changed) {
          merged.set(itemId, this.get(itemId))
        }
        await this.store.saveSyncedHeads(Array.from(merged.entries()))
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

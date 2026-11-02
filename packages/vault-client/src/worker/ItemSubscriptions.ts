import type { DocHandle, Repo } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import type { RepoDoc } from './docStore'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ItemSubscriptions')

/**
 * Keeps a change listener on the doc handle of every subscribed item. Each listener is detached with
 * the same function reference it was attached with.
 */
export class ItemSubscriptions {
  private readonly subscribedIds = new Set<ItemId>()
  private readonly listenersByItemId = new Map<ItemId, { handle: DocHandle<RepoDoc>; listener: () => void }>()

  /**
   * @param getRepo Returns the repo handles are found in
   * @param onChange Called with an item's handle when it is bound and on every change to it
   */
  constructor(
    private readonly getRepo: () => Repo,
    private readonly onChange: (itemId: ItemId, handle: DocHandle<RepoDoc>) => void,
  ) {}

  has(itemId: ItemId): boolean {
    return this.subscribedIds.has(itemId)
  }

  subscribe(itemIds: ItemId[]): void {
    const repo = this.getRepo()
    for (const id of itemIds) {
      if (this.subscribedIds.has(id)) continue
      this.subscribedIds.add(id)

      const url = toAutomergeUrlFromItemId(id)
      fireAndForget(
        repo.find<RepoDoc>(url).then(
          handle => {
            if (!this.subscribedIds.has(id)) return
            const currentHandle = (repo.handles?.[handle.documentId] as DocHandle<RepoDoc> | undefined) ?? handle
            this.bind(id, currentHandle)
          },
          (err: unknown) => {
            // Forgotten so a later subscribe tries again, unless a handle has been bound since
            if (!this.listenersByItemId.has(id)) {
              this.subscribedIds.delete(id)
            }
            throw err
          },
        ),
        'ItemSubscriptions:subscribe:find',
      )
    }
  }

  /** Subscribes to every item in `itemIds` and unsubscribes from every other */
  update(itemIds: ItemId[]): void {
    this.subscribe(itemIds)

    const itemIdsSet = new Set(itemIds)
    for (const subscribedId of Array.from(this.subscribedIds)) {
      if (!itemIdsSet.has(subscribedId)) {
        this.unsubscribe(subscribedId)
      }
    }
  }

  /** Moves a subscribed item's listener to the handle that replaced its old one */
  rebind(itemId: ItemId, handle: DocHandle<RepoDoc>): void {
    if (this.subscribedIds.has(itemId) || this.listenersByItemId.has(itemId)) {
      this.subscribedIds.add(itemId)
      this.bind(itemId, handle)
    }
  }

  unsubscribe(itemId: ItemId): void {
    this.subscribedIds.delete(itemId)
    const sub = this.listenersByItemId.get(itemId)
    this.listenersByItemId.delete(itemId)

    if (sub) {
      sub.handle.off('change', sub.listener)
    }
  }

  clear(): void {
    for (const [, sub] of this.listenersByItemId) {
      sub.handle.off('change', sub.listener)
    }
    this.subscribedIds.clear()
    this.listenersByItemId.clear()
  }

  private bind(id: ItemId, handle: DocHandle<RepoDoc>): void {
    const existing = this.listenersByItemId.get(id)
    if (existing) {
      existing.handle.off('change', existing.listener)
    }

    const handleChange = () => {
      try {
        this.onChange(id, handle)
      } catch (err) {
        log.error(`Error handling Automerge doc change for item ${id}:`, err)
      }
    }
    handle.on('change', handleChange)
    this.listenersByItemId.set(id, { handle, listener: handleChange })
    handleChange()
  }
}

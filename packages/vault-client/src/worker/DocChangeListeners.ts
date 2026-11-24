import type { DocHandle, DocumentId, Repo } from '@automerge/automerge-repo/slim'
import type { ItemId } from '@vault/shared'
import { isIndexDocument, toVaultItemIdFromAutomergeId } from './utils/automerge'
import { createLogger } from '../utils/logger'

const log = createLogger('DocChangeListeners')

interface Attached {
  handle: DocHandle<unknown>
  listener: () => void
}

/**
 * Keeps one change listener on each item's handle in the Repo, whatever found or created it, and calls
 * `onDocChanged` with the item's ID when its doc changes. Each listener is removed with the same
 * function reference it was added with (sync rule 6): when the Repo deletes the doc, when another
 * handle takes the item's place, and on `clear`.
 *
 * automerge-repo declares a `document` event for new handles but this version never emits it, so the
 * Repo's owner tells this about handles as they come in: `watchReceivedDocument` for docs other tabs
 * send it, and `watchHandle` for handles the doc store finds or creates.
 */
export class DocChangeListeners {
  private readonly attached = new Map<ItemId, Attached>()
  private isCleared = false

  constructor(
    private readonly repo: Pick<Repo, 'handles' | 'on' | 'off'>,
    private readonly onDocChanged: (itemId: ItemId) => void,
  ) {
    repo.on('delete-document', this.handleDeleteDocument)
  }

  /**
   * Listens to the handle the Repo holds for a document another tab sent a message about, which the
   * Repo creates if it has none. The message has been dispatched by now and may already have changed
   * the doc, so a handle that wasn't being listened to counts as changed.
   */
  watchReceivedDocument(documentId: DocumentId): void {
    const handle: DocHandle<unknown> | undefined = this.repo.handles[documentId]
    if (!handle) return
    this.watchHandle(handle)?.()
  }

  /**
   * Listens to the handle, unless it already is. Returns the listener when one was added, so a
   * caller can run it.
   */
  watchHandle(handle: DocHandle<unknown>): (() => void) | undefined {
    if (this.isCleared) return undefined
    const itemId = toVaultItemIdFromAutomergeId(handle.documentId)
    if (!itemId || isIndexDocument(itemId)) return undefined

    const existing = this.attached.get(itemId)
    if (existing?.handle === handle) return undefined
    if (existing) existing.handle.off('change', existing.listener)

    const listener = () => {
      try {
        this.onDocChanged(itemId)
      } catch (err) {
        log.error(`Error handling a change to item ${itemId}:`, err)
      }
    }
    handle.on('change', listener)
    this.attached.set(itemId, { handle, listener })
    return listener
  }

  /** Removes the listener from the item's handle */
  unwatch(itemId: ItemId): void {
    const existing = this.attached.get(itemId)
    if (!existing) return
    existing.handle.off('change', existing.listener)
    this.attached.delete(itemId)
  }

  /** Removes every listener, and adds none after */
  clear(): void {
    this.isCleared = true
    this.repo.off('delete-document', this.handleDeleteDocument)
    for (const { handle, listener } of this.attached.values()) {
      handle.off('change', listener)
    }
    this.attached.clear()
  }

  private readonly handleDeleteDocument = ({ documentId }: { documentId: DocumentId }): void => {
    this.unwatch(toVaultItemIdFromAutomergeId(documentId))
  }
}

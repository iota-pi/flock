type Listener = () => void

export type AutomergeReactivity = {
  notifyAllItemListeners: () => void
  notifyItemListeners: (itemIds: string[]) => void
  notifyMetadataListeners: () => void
  subscribeAutomergeItems: (listener: () => void) => () => void
  subscribeAutomergeItem: (itemId: string, listener: () => void) => () => void
  subscribeAutomergeMetadata: (listener: () => void) => () => void
}

function emitListeners(listeners: Set<Listener> | undefined): void {
  if (!listeners || listeners.size === 0) {
    return
  }

  for (const listener of Array.from(listeners)) {
    listener()
  }
}

export function createAutomergeReactivity(): AutomergeReactivity {
  const itemListenersById = new Map<string, Set<Listener>>()
  const itemsListeners = new Set<Listener>()
  const metadataListeners = new Set<Listener>()

  function emitItem(itemId: string): void {
    emitListeners(itemListenersById.get(itemId))
  }

  function notifyAllItemListeners(): void {
    emitListeners(itemsListeners)

    for (const listeners of itemListenersById.values()) {
      emitListeners(listeners)
    }
  }

  function notifyItemListeners(itemIds: string[]): void {
    const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => typeof itemId === 'string' && itemId.length > 0)))
    if (uniqueItemIds.length === 0) {
      return
    }

    for (const itemId of uniqueItemIds) {
      emitItem(itemId)
    }

    emitListeners(itemsListeners)
  }

  function notifyMetadataListeners(): void {
    emitListeners(metadataListeners)
  }

  function subscribeAutomergeItems(listener: () => void): () => void {
    itemsListeners.add(listener)

    return () => {
      itemsListeners.delete(listener)
    }
  }

  function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
    const listeners = itemListenersById.get(itemId) || new Set<Listener>()
    itemListenersById.set(itemId, listeners)
    listeners.add(listener)

    return () => {
      const existing = itemListenersById.get(itemId)
      if (!existing) {
        return
      }

      existing.delete(listener)
      if (existing.size === 0) {
        itemListenersById.delete(itemId)
      }
    }
  }

  function subscribeAutomergeMetadata(listener: () => void): () => void {
    metadataListeners.add(listener)

    return () => {
      metadataListeners.delete(listener)
    }
  }

  return {
    notifyAllItemListeners,
    notifyItemListeners,
    notifyMetadataListeners,
    subscribeAutomergeItems,
    subscribeAutomergeItem,
    subscribeAutomergeMetadata,
  }
}

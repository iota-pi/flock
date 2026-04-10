import { createStore } from 'zustand/vanilla'

type ReactivityState = {
  itemsRevision: number
  metadataRevision: number
  itemRevisionById: Record<string, number>
}

type CreateAutomergeReactivityInput = {
  markItemsSnapshotDirty: () => void
  markMetadataSnapshotDirty: () => void
}

export type AutomergeReactivity = {
  notifyAllItemListeners: () => void
  notifyItemListeners: (itemIds: string[]) => void
  notifyMetadataListeners: () => void
  subscribeAutomergeItems: (listener: () => void) => () => void
  subscribeAutomergeItem: (itemId: string, listener: () => void) => () => void
  subscribeAutomergeMetadata: (listener: () => void) => () => void
}

export function createAutomergeReactivity(
  input: CreateAutomergeReactivityInput,
): AutomergeReactivity {
  const store = createStore<ReactivityState>(() => ({
    itemsRevision: 0,
    metadataRevision: 0,
    itemRevisionById: {},
  }))

  function notifyAllItemListeners(): void {
    store.setState(state => ({
      ...state,
      itemsRevision: state.itemsRevision + 1,
    }))
  }

  function notifyItemListeners(itemIds: string[]): void {
    const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => typeof itemId === 'string' && itemId.length > 0)))
    if (uniqueItemIds.length === 0) {
      return
    }

    input.markItemsSnapshotDirty()

    store.setState(state => {
      const nextItemRevisionById = {
        ...state.itemRevisionById,
      }

      for (const itemId of uniqueItemIds) {
        nextItemRevisionById[itemId] = (nextItemRevisionById[itemId] || 0) + 1
      }

      return {
        ...state,
        itemsRevision: state.itemsRevision + 1,
        itemRevisionById: nextItemRevisionById,
      }
    })
  }

  function notifyMetadataListeners(): void {
    input.markMetadataSnapshotDirty()

    store.setState(state => ({
      ...state,
      metadataRevision: state.metadataRevision + 1,
    }))
  }

  function subscribeAutomergeItems(listener: () => void): () => void {
    return store.subscribe((state, previousState) => {
      if (state.itemsRevision !== previousState.itemsRevision) {
        listener()
      }
    })
  }

  function subscribeAutomergeItem(itemId: string, listener: () => void): () => void {
    return store.subscribe((state, previousState) => {
      const nextSignal = state.itemRevisionById[itemId] || 0
      const previousSignal = previousState.itemRevisionById[itemId] || 0

      if (nextSignal !== previousSignal) {
        listener()
      }
    })
  }

  function subscribeAutomergeMetadata(listener: () => void): () => void {
    return store.subscribe((state, previousState) => {
      if (state.metadataRevision !== previousState.metadataRevision) {
        listener()
      }
    })
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

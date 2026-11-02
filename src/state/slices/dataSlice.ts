import type { StateCreator } from 'zustand'
import type { Item } from '../items'
import type { AccountMetadata } from '../metadata'
import type { ItemId } from '@vault/shared'
import type { AppStore } from '../store'

interface DataState {
  dataStatus: 'initializing' | 'ready'
  items: Record<string, Item>
  itemIds: ItemId[]
  metadata: AccountMetadata
  processedItemIds: Set<string>
  hasReceivedIndex: boolean
}

interface DataActions {
  setReady: () => void
  updateItemsFromServer: (updates: Array<{ id: string, item: Item | null }>) => void
  updateIndexFromServer: (itemIds: ItemId[]) => void
  updateMetadata: (metadata: AccountMetadata) => void
  optimisticUpdateItem: (id: string, partial: Partial<Item>) => void
  reset: () => void
}

export type DataSlice = DataState & DataActions

let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null
const READY_TIMEOUT_MS = 5000

function clearFallbackTimeout() {
  if (fallbackTimeoutId) {
    clearTimeout(fallbackTimeoutId)
    fallbackTimeoutId = null
  }
}

/** The state that finishes initializing, once every indexed item has been processed */
function readyIfComplete(itemIds: ItemId[], processedItemIds: Set<string>): Partial<DataState> | null {
  if (!itemIds.every(id => processedItemIds.has(id))) {
    return null
  }

  clearFallbackTimeout()
  return { dataStatus: 'ready', processedItemIds: new Set() }
}

function getInitialState(): DataState {
  return {
    dataStatus: 'initializing',
    items: {},
    itemIds: [],
    metadata: {},
    processedItemIds: new Set<string>(),
    hasReceivedIndex: false,
  }
}

export const createDataSlice: StateCreator<
  AppStore,
  [],
  [],
  DataSlice
> = (set, get) => ({
  ...getInitialState(),

  setReady: () => {
    clearFallbackTimeout()
    set(state => {
      if (state.dataStatus === 'ready') return {}
      return { dataStatus: 'ready', processedItemIds: new Set() }
    })
  },

  updateItemsFromServer: updates =>
    set(state => {
      const initializing = state.dataStatus === 'initializing'
      const nextItems = { ...state.items }
      const nextProcessed = initializing ? new Set(state.processedItemIds) : state.processedItemIds

      for (const update of updates) {
        if (initializing) {
          nextProcessed.add(update.id)
        }

        if (update.item) {
          nextItems[update.id] = { ...update.item, isNew: undefined }
        } else {
          delete nextItems[update.id]
        }
      }

      return {
        items: nextItems,
        processedItemIds: nextProcessed,
        ...(initializing && state.hasReceivedIndex ? readyIfComplete(state.itemIds, nextProcessed) : null),
      }
    }),

  updateIndexFromServer: itemIds => {
    set(state => ({
      itemIds,
      hasReceivedIndex: true,
      ...(state.dataStatus === 'initializing' ? readyIfComplete(itemIds, state.processedItemIds) : null),
    }))

    if (get().dataStatus === 'initializing' && !fallbackTimeoutId && itemIds.length > 0) {
      fallbackTimeoutId = setTimeout(() => {
        get().setReady()
      }, READY_TIMEOUT_MS)
    }
  },

  updateMetadata: metadata =>
    set(state => ({
      metadata: {
        ...state.metadata,
        ...metadata,
      },
    })),

  optimisticUpdateItem: (id, partial) =>
    set(state => {
      const existing = state.items[id]
      const nextItems = {
        ...state.items,
        [id]: { ...existing, ...partial } as Item,
      }
      const nextItemIds = state.itemIds.includes(id as ItemId)
        ? state.itemIds
        : [...state.itemIds, id as ItemId]

      return {
        items: nextItems,
        itemIds: nextItemIds,
      }
    }),

  reset: () => {
    clearFallbackTimeout()
    set(getInitialState())
  },
})

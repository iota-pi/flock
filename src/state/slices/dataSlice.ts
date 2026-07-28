import type { StateCreator } from 'zustand'
import type { Item } from '../items'
import type { AccountMetadata } from '../metadata'
import { ItemId } from 'src/shared/schemas/items'
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
  updateMetadataFromServer: (metadata: AccountMetadata) => void
  optimisticUpdateItem: (id: string, partial: Partial<Item>) => void
  reset: () => void
}

export type DataSlice = DataState & DataActions

let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null
const READY_TIMEOUT_MS = 5000

export const createDataSlice: StateCreator<
  AppStore,
  [],
  [],
  DataSlice
> = (set, get) => ({
  dataStatus: 'initializing',
  items: {},
  itemIds: [],
  metadata: {},
  processedItemIds: new Set<string>(),
  hasReceivedIndex: false,

  setReady: () => {
    if (fallbackTimeoutId) {
      clearTimeout(fallbackTimeoutId)
      fallbackTimeoutId = null
    }
    set(state => {
      if (state.dataStatus === 'ready') return {}
      return { dataStatus: 'ready', processedItemIds: new Set() }
    })
  },

  updateItemsFromServer: updates =>
    set(state => {
      const nextItems = { ...state.items }
      let nextProcessed = state.processedItemIds
      let nextStatus = state.dataStatus

      if (nextStatus === 'initializing') {
        nextProcessed = new Set(state.processedItemIds)
      }

      for (const update of updates) {
        if (nextStatus === 'initializing') {
          nextProcessed.add(update.id)
        }

        if (update.item) {
          nextItems[update.id] = update.item
        } else {
          delete nextItems[update.id]
        }
      }

      if (nextStatus === 'initializing' && state.hasReceivedIndex) {
        const isReady = state.itemIds.every(id => nextProcessed.has(id))
        if (isReady) {
          nextStatus = 'ready'
          nextProcessed = new Set() // free memory
          if (fallbackTimeoutId) {
            clearTimeout(fallbackTimeoutId)
            fallbackTimeoutId = null
          }
        }
      }

      return {
        items: nextItems,
        dataStatus: nextStatus,
        processedItemIds: nextProcessed,
      }
    }),

  updateIndexFromServer: itemIds => {
    set(state => {
      const nextState: Partial<DataState> = {
        itemIds,
        hasReceivedIndex: true,
      }

      if (state.dataStatus === 'initializing') {
        const isReady = itemIds.every(id => state.processedItemIds.has(id))
        if (isReady) {
          if (fallbackTimeoutId) {
            clearTimeout(fallbackTimeoutId)
            fallbackTimeoutId = null
          }
          nextState.dataStatus = 'ready'
          nextState.processedItemIds = new Set()
        }
      }
      return nextState
    })

    const currentState = get()
    if (currentState.dataStatus === 'initializing' && !fallbackTimeoutId && itemIds.length > 0) {
      fallbackTimeoutId = setTimeout(() => {
        get().setReady()
      }, READY_TIMEOUT_MS)
    }
  },

  updateMetadataFromServer: metadata =>
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
    if (fallbackTimeoutId) {
      clearTimeout(fallbackTimeoutId)
      fallbackTimeoutId = null
    }
    set({
      dataStatus: 'initializing',
      items: {},
      itemIds: [],
      metadata: {},
      processedItemIds: new Set<string>(),
      hasReceivedIndex: false,
    })
  },
})

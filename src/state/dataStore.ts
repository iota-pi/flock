import { create } from 'zustand'

import type { Item } from './items'
import type { AccountMetadata } from './metadata'
import { ItemId } from 'src/shared/schemas/items'


interface DataState {
  status: 'initializing' | 'ready'
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

export type DataStore = DataState & DataActions

let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null
const READY_TIMEOUT_MS = 5000

export const useDataStore = create<DataStore>((set, get) => ({
  status: 'initializing',
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
      if (state.status === 'ready') return state
      return { status: 'ready', processedItemIds: new Set() }
    })
  },

  updateItemsFromServer: updates => set(state => {
    const nextItems = { ...state.items }
    let nextProcessed = state.processedItemIds
    let nextStatus = state.status

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
      status: nextStatus,
      processedItemIds: nextProcessed,
    }
  }),

  updateIndexFromServer: itemIds => {
    set(state => {
      const nextState: Partial<DataState> = {
        itemIds,
        hasReceivedIndex: true,
      }

      if (state.status === 'initializing') {
        const isReady = itemIds.every(id => state.processedItemIds.has(id))
        if (isReady) {
          if (fallbackTimeoutId) {
            clearTimeout(fallbackTimeoutId)
            fallbackTimeoutId = null
          }
          nextState.status = 'ready'
          nextState.processedItemIds = new Set()
        }
      }
      return nextState
    })

    const currentState = get()
    if (currentState.status === 'initializing' && !fallbackTimeoutId && itemIds.length > 0) {
      fallbackTimeoutId = setTimeout(() => {
        get().setReady()
      }, READY_TIMEOUT_MS)
    }
  },

  updateMetadataFromServer: metadata => set(state => ({
    metadata: {
      ...state.metadata,
      ...metadata,
    },
  })),

  optimisticUpdateItem: (id, partial) => set(state => {
    if (!state.items[id]) return state
    return {
      items: {
        ...state.items,
        [id]: { ...state.items[id], ...partial } as Item,
      },
    }
  }),

  reset: () => {
    if (fallbackTimeoutId) {
      clearTimeout(fallbackTimeoutId)
      fallbackTimeoutId = null
    }
    set({
      status: 'initializing',
      items: {},
      itemIds: [],
      metadata: {},
      processedItemIds: new Set<string>(),
      hasReceivedIndex: false,
    })
  },
}))

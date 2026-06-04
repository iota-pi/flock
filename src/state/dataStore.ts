import { create } from 'zustand'
import type { Item } from './items'
import type { AccountMetadata } from './metadata'

interface DataState {
  status: 'initializing' | 'ready'
  items: Record<string, Item>
  itemIds: string[]
  metadata: AccountMetadata
  processedItemIds: Set<string>
}

interface DataActions {
  setReady: () => void
  updateItemsFromServer: (updates: Array<{ id: string, item: Item | null }>) => void
  updateIndexFromServer: (itemIds: string[]) => void
  updateMetadataFromServer: (metadata: AccountMetadata) => void
  optimisticUpdateItem: (id: string, partial: Partial<Item>) => void
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

    if (nextStatus === 'initializing' && nextProcessed.size >= state.itemIds.length) {
      nextStatus = 'ready'
      nextProcessed = new Set() // free memory
      if (fallbackTimeoutId) {
        clearTimeout(fallbackTimeoutId)
        fallbackTimeoutId = null
      }
    }

    return { 
      items: nextItems, 
      status: nextStatus, 
      processedItemIds: nextProcessed 
    }
  }),

  updateIndexFromServer: itemIds => {
    set(state => {
      if (state.status === 'initializing' && itemIds.length === 0) {
        if (fallbackTimeoutId) {
          clearTimeout(fallbackTimeoutId)
          fallbackTimeoutId = null
        }
        return { itemIds, status: 'ready', processedItemIds: new Set() }
      }
      return { itemIds }
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
}))

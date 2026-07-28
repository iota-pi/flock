import { create } from 'zustand'
import type { Item } from './items'
import type { AccountMetadata } from './metadata'

interface DataState {
  status: 'initializing' | 'ready'
  items: Record<string, Item>
  itemIds: string[]
  metadata: AccountMetadata
}

interface DataActions {
  updateItemsFromServer: (updates: Array<{ id: string, item: Item | null }>) => void
  updateIndexFromServer: (itemIds: string[]) => void
  updateMetadataFromServer: (metadata: AccountMetadata) => void
  optimisticUpdateItem: (id: string, partial: Partial<Item>) => void
}

export type DataStore = DataState & DataActions

export const useDataStore = create<DataStore>(set => ({
  status: 'initializing',
  items: {},
  itemIds: [],
  metadata: {},

  updateItemsFromServer: updates => set(state => {
    const nextItems = { ...state.items }
    for (const update of updates) {
      if (update.item) {
        nextItems[update.id] = update.item
      } else {
        delete nextItems[update.id]
      }
    }

    let nextStatus = state.status
    if (nextStatus === 'initializing') {
      if (Object.keys(nextItems).length >= state.itemIds.length) {
        nextStatus = 'ready'
      }
    }

    return { items: nextItems, status: nextStatus }
  }),

  updateIndexFromServer: itemIds => set(state => {
    const nextStatus = state.status === 'initializing' && itemIds.length === 0
      ? 'ready'
      : state.status

    return {
      itemIds,
      status: nextStatus,
    }
  }),

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

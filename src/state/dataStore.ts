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
  setFullState: (payload: { items: Record<string, Item>; itemIds: string[]; metadata: AccountMetadata }) => void
  updateItemFromServer: (id: string, item: Item | null) => void
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

  setFullState: payload => set(() => ({
    status: 'ready',
    items: payload.items,
    itemIds: payload.itemIds,
    metadata: payload.metadata,
  })),

  updateItemFromServer: (id, item) => set(state => {
    const nextItems = { ...state.items }
    if (item) {
      nextItems[id] = item
    } else {
      delete nextItems[id]
    }
    return { items: nextItems }
  }),

  updateIndexFromServer: itemIds => set(() => ({ itemIds })),

  updateMetadataFromServer: metadata => set(() => ({ metadata })),

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

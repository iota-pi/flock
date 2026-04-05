import { create } from 'zustand'
import { generateItemId } from '../utils'
import type { ItemId } from '../shared/itemTypes'
import type { Item } from './items'

export interface DrawerData {
  id: string
  item?: ItemId
  newItem?: Item
}

export type PushActiveOptions = 'newItem'

export type PushActiveData = (
  Pick<DrawerData, 'item'> & Partial<Pick<DrawerData, PushActiveOptions>>
)

export interface NavigationState {
  drawers: DrawerData[]
  selected: ItemId[]
}

export interface NavigationStore extends NavigationState {
  setSelected: (selected: ItemId[]) => void
  toggleSelected: (itemId: ItemId) => void
  replaceActive: (payload: Partial<Omit<DrawerData, 'id'>>) => void
  pushActive: (payload: PushActiveData) => void
  removeActive: () => void
  clearDrawers: () => void
  pruneItemDrawers: (itemIds: ItemId[]) => void
}

const initialNavigationState: NavigationState = {
  drawers: [],
  selected: [],
}

export const useNavigationStore = create<NavigationStore>(set => ({
  ...initialNavigationState,
  setSelected: selected => {
    set(() => ({ selected }))
  },
  toggleSelected: itemId => {
    set(state => ({
      selected: state.selected.includes(itemId)
        ? state.selected.filter(id => id !== itemId)
        : [...state.selected, itemId],
    }))
  },
  replaceActive: payload => {
    set(state => {
      const lastItem = state.drawers[state.drawers.length - 1]
      const newItem: DrawerData = {
        id: lastItem ? lastItem.id : generateItemId(),
        ...payload,
      }
      const drawers = [...state.drawers]
      if (lastItem) {
        drawers[drawers.indexOf(lastItem)] = newItem
      } else {
        drawers.push(newItem)
      }
      return { drawers }
    })
  },
  pushActive: payload => {
    set(state => ({
      drawers: [
        ...state.drawers,
        {
          id: generateItemId(),
          ...payload,
        },
      ],
    }))
  },
  removeActive: () => {
    set(state => ({
      drawers: state.drawers.slice(0, -1),
    }))
  },
  clearDrawers: () => {
    set(() => ({ drawers: [] }))
  },
  pruneItemDrawers: itemIds => {
    set(state => {
      const newDrawers: typeof state.drawers = []
      let modified = false
      for (const drawer of state.drawers) {
        if (drawer.item && itemIds.includes(drawer.item)) {
          modified = true
        } else {
          newDrawers.push(drawer)
        }
      }

      return {
        drawers: modified ? newDrawers : state.drawers,
        selected: state.selected.filter(id => !itemIds.includes(id)),
      }
    })
  },
}))

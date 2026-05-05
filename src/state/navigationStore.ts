import { create } from 'zustand'
import { generateItemId } from '../utils'
import type { ItemId } from '../shared/itemTypes'
import type { Item, StandardItem } from './items'

export type DrawerOnChange = (
  item: Partial<Omit<Item, 'type' | 'id'>> | ((prev: Item) => Item),
) => void

export interface DrawerData {
  id: string
  item?: ItemId
  initialItem?: StandardItem
  alwaysTemporary?: boolean
  disableRouting?: boolean
  fromPrayerPage?: boolean
  open?: boolean
}

type DrawerPayload = Partial<Omit<DrawerData, 'id'>>

interface NavigationState {
  drawer: DrawerData | null
  selected: ItemId[]
}

interface NavigationStore extends NavigationState {
  setSelected: (selected: ItemId[]) => void
  toggleSelected: (itemId: ItemId) => void
  setDrawer: (payload: DrawerPayload) => void
  removeDrawer: () => void
  closeIfOpen: (itemIds: ItemId[]) => void
}

const initialNavigationState: NavigationState = {
  drawer: null,
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
  setDrawer: payload => {
    set(state => ({
      drawer: {
        id: state.drawer ? state.drawer.id : generateItemId(),
        ...payload,
      },
    }))
  },
  removeDrawer: () => {
    set(() => ({
      drawer: null,
    }))
  },
  closeIfOpen: itemIds => {
    set(state => {
      const shouldClose = state.drawer?.item && itemIds.includes(state.drawer.item)

      return {
        drawer: shouldClose ? null : state.drawer,
        selected: state.selected.filter(id => !itemIds.includes(id)),
      }
    })
  },
}))

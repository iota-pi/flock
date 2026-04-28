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
  onChange?: DrawerOnChange
  onCloseRequest?: () => void
  onExited?: () => void
  open?: boolean
}

type DrawerPayload = Partial<Omit<DrawerData, 'id'>>

interface NavigationState {
  activeDrawer: DrawerData | null
  selected: ItemId[]
}

interface NavigationStore extends NavigationState {
  setSelected: (selected: ItemId[]) => void
  toggleSelected: (itemId: ItemId) => void
  setDrawer: (payload: DrawerPayload) => void
  removeActive: () => void
  clearDrawers: () => void
  pruneItemDrawers: (itemIds: ItemId[]) => void
}

const initialNavigationState: NavigationState = {
  activeDrawer: null,
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
      activeDrawer: {
        id: state.activeDrawer ? state.activeDrawer.id : generateItemId(),
        ...payload,
      },
    }))
  },
  removeActive: () => {
    set(() => ({
      activeDrawer: null,
    }))
  },
  clearDrawers: () => {
    set(() => ({ activeDrawer: null }))
  },
  pruneItemDrawers: itemIds => {
    set(state => {
      const isDrawerItemPruned = state.activeDrawer?.item && itemIds.includes(state.activeDrawer.item)

      return {
        activeDrawer: isDrawerItemPruned ? null : state.activeDrawer,
        selected: state.selected.filter(id => !itemIds.includes(id)),
      }
    })
  },
}))

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
  stacked?: boolean
}

type DrawerPayload = Partial<Omit<DrawerData, 'id'>>

interface NavigationState {
  drawers: DrawerData[]
  selected: ItemId[]
}

interface NavigationStore extends NavigationState {
  setSelected: (selected: ItemId[]) => void
  toggleSelected: (itemId: ItemId) => void
  replaceActive: (payload: DrawerPayload) => void
  pushActive: (payload: DrawerPayload) => void
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
      const lastDrawer = state.drawers[state.drawers.length - 1]
      const nextDrawer: DrawerData = {
        id: lastDrawer ? lastDrawer.id : generateItemId(),
        ...payload,
      }
      const drawers = [...state.drawers]
      if (lastDrawer) {
        drawers[drawers.indexOf(lastDrawer)] = nextDrawer
      } else {
        drawers.push(nextDrawer)
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

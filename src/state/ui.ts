import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { AlertColor } from '@mui/material'
import { generateItemId } from '../utils'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../utils/customFilter'
import { ItemId, Item } from './items'

export interface DrawerData {
  id: string,
  initial?: Item[],
  item?: ItemId,
  newItem?: Item,
  next?: string[],
  open: boolean,
  praying?: boolean,
}
export interface UiOptions {
  bulkActionsOnMobile: boolean,
}
export interface RequestData {
  active: number,
}
export interface BaseUIMessage {
  severity?: AlertColor,
  message: string,
}
export type UIMessage = Required<BaseUIMessage>
export interface UIState {
  darkMode: boolean | null,
  drawers: DrawerData[],
  filters: FilterCriterion[],
  message: UIMessage | null,
  options: UiOptions,
  requests: RequestData,
  selected: ItemId[],
  justCreatedAccount: boolean,
}

const initialState: UIState = {
  darkMode: null,
  drawers: [],
  filters: DEFAULT_FILTER_CRITERIA,
  message: null,
  options: {
    bulkActionsOnMobile: false,
  },
  requests: {
    active: 0,
  },
  selected: [],
  justCreatedAccount: false,
}

export type setUi = Omit<Partial<UIState>, 'options' | 'requests' | 'drawers'> & {
  options?: Partial<UIState['options']>,
  requests?: Partial<UIState['requests']>,
}
export type PushActiveOptions = (
  'initial' | 'newItem' | 'next' | 'open' | 'praying'
)
export type PushActiveData = (
  Pick<DrawerData, 'item'> & Partial<Pick<DrawerData, PushActiveOptions>>
)

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setUi(state, action: PayloadAction<setUi>) {
      return {
        ...state,
        ...action.payload,
        options: {
          ...state.options,
          ...action.payload.options,
        },
        requests: {
          ...state.requests,
          ...action.payload.requests,
        },
      }
    },
    startRequest(state) {
      state.requests.active += 1
    },
    finishRequest(state, action: PayloadAction<string | undefined>) {
      state.requests.active -= 1
      if (action.payload) {
        state.message = {
          severity: 'error',
          message: action.payload,
        }
      }
    },
    setMessage(state, action: PayloadAction<BaseUIMessage>) {
      state.message = {
        severity: action.payload.severity || 'success',
        message: action.payload.message,
      }
    },
    toggleSelected(state, action: PayloadAction<ItemId>) {
      const index = state.selected.indexOf(action.payload)
      if (index > -1) {
        state.selected.splice(index, 1)
      } else {
        state.selected.push(action.payload)
      }
    },
    replaceActive(state, action: PayloadAction<Partial<Omit<DrawerData, 'id'>>>) {
      const openItems = state.drawers.filter(drawer => drawer.open)
      const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
      const newItem: DrawerData = {
        id: lastItem ? lastItem.id : generateItemId(),
        open: true,
        ...action.payload,
      }
      if (lastItem) {
        state.drawers[state.drawers.indexOf(lastItem)] = newItem
      } else {
        state.drawers.push(newItem)
      }
    },
    updateActive(state, action: PayloadAction<Partial<Omit<DrawerData, 'id'>>>) {
      const openItems = state.drawers.filter(drawer => drawer.open)
      const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
      const newItem: DrawerData = {
        id: generateItemId(),
        open: true,
        ...lastItem,
        ...action.payload,
      }
      state.drawers[state.drawers.length - 1] = newItem
    },
    pushActive(state, action: PayloadAction<PushActiveData>) {
      const newItem: DrawerData = {
        id: generateItemId(),
        open: true,
        ...action.payload,
      }
      state.drawers.push(newItem)
    },
    removeActive(state) {
      state.drawers.splice(state.drawers.length - 1, 1)
    },
    pruneItems(state, action: PayloadAction<ItemId[]>) {
      const newDrawers: typeof state.drawers = []
      let modified = false
      for (const drawer of state.drawers) {
        if (drawer.item && action.payload.includes(drawer.item)) {
          modified = true
        } else if (drawer.next && drawer.next.find(item => !action.payload.includes(item))) {
          newDrawers.push({
            ...drawer,
            next: drawer.next.filter(item => !action.payload.includes(item)),
          })
          modified = true
        } else {
          newDrawers.push(drawer)
        }
      }
      if (modified) {
        state.drawers = newDrawers
      }

      state.selected = state.selected.filter(id => !action.payload.includes(id))
    },
  },
})

export const {
  finishRequest,
  pushActive,
  removeActive,
  replaceActive,
  setMessage,
  setUi,
  startRequest,
  toggleSelected,
  updateActive,
  pruneItems,
} = uiSlice.actions
export default uiSlice.reducer

export const PUSH_ACTIVE = 'PUSH_ACTIVE'
export const REMOVE_ACTIVE = 'REMOVE_ACTIVE'

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
  requests: RequestData,
  selected: ItemId[],
  justCreatedAccount: boolean,
}

export const initialState: UIState = {
  darkMode: null,
  drawers: [],
  filters: DEFAULT_FILTER_CRITERIA,
  message: null,
  requests: {
    active: 0,
  },
  selected: [],
  justCreatedAccount: false,
}

export type SetUiPayload = Omit<Partial<UIState>, 'requests' | 'drawers'> & {
  requests?: Partial<UIState['requests']>,
}
export type PushActiveOptions = (
  'initial' | 'newItem' | 'next' | 'open' | 'praying'
)
export type PushActiveData = (
  Pick<DrawerData, 'item'> & Partial<Pick<DrawerData, PushActiveOptions>>
)

export const UI_SET = 'ui/setUi'
export const UI_START_REQUEST = 'ui/startRequest'
export const UI_FINISH_REQUEST = 'ui/finishRequest'
export const UI_SET_MESSAGE = 'ui/setMessage'
export const UI_TOGGLE_SELECTED = 'ui/toggleSelected'
export const UI_REPLACE_ACTIVE = 'ui/replaceActive'
export const UI_UPDATE_ACTIVE = 'ui/updateActive'
export const UI_PUSH_ACTIVE = 'ui/pushActive'
export const UI_REMOVE_ACTIVE = 'ui/removeActive'
export const UI_CLEAR_DRAWERS = 'ui/clearDrawers'
export const UI_PRUNE_ITEM_DRAWERS = 'ui/pruneItemDrawers'

export function setUi(payload: SetUiPayload) {
  return { type: UI_SET, payload } as const
}

export function startRequest() {
  return { type: UI_START_REQUEST } as const
}

export function finishRequest(payload?: string) {
  return { type: UI_FINISH_REQUEST, payload } as const
}

export function setMessage(payload: BaseUIMessage) {
  return { type: UI_SET_MESSAGE, payload } as const
}

export function toggleSelected(payload: ItemId) {
  return { type: UI_TOGGLE_SELECTED, payload } as const
}

export function replaceActive(payload: Partial<Omit<DrawerData, 'id'>>) {
  return { type: UI_REPLACE_ACTIVE, payload } as const
}

export function updateActive(payload: Partial<Omit<DrawerData, 'id'>>) {
  return { type: UI_UPDATE_ACTIVE, payload } as const
}

export function pushActive(payload: PushActiveData) {
  return { type: UI_PUSH_ACTIVE, payload } as const
}

export function removeActive() {
  return { type: UI_REMOVE_ACTIVE } as const
}

export function clearDrawers() {
  return { type: UI_CLEAR_DRAWERS } as const
}

export function pruneItemDrawers(payload: ItemId[]) {
  return { type: UI_PRUNE_ITEM_DRAWERS, payload } as const
}

export type UIAction =
  | ReturnType<typeof setUi>
  | ReturnType<typeof startRequest>
  | ReturnType<typeof finishRequest>
  | ReturnType<typeof setMessage>
  | ReturnType<typeof toggleSelected>
  | ReturnType<typeof replaceActive>
  | ReturnType<typeof updateActive>
  | ReturnType<typeof pushActive>
  | ReturnType<typeof removeActive>
  | ReturnType<typeof clearDrawers>
  | ReturnType<typeof pruneItemDrawers>

export function reduceUi(state: UIState, action: UIAction): UIState {
  switch (action.type) {
    case UI_SET:
      return {
        ...state,
        ...action.payload,
        requests: {
          ...state.requests,
          ...action.payload.requests,
        },
      }
    case UI_START_REQUEST:
      return {
        ...state,
        requests: { active: state.requests.active + 1 },
      }
    case UI_FINISH_REQUEST:
      return {
        ...state,
        requests: { active: Math.max(0, state.requests.active - 1) },
        message: action.payload
          ? { severity: 'error', message: action.payload }
          : state.message,
      }
    case UI_SET_MESSAGE:
      return {
        ...state,
        message: {
          severity: action.payload.severity || 'success',
          message: action.payload.message,
        },
      }
    case UI_TOGGLE_SELECTED: {
      const selected = state.selected.includes(action.payload)
        ? state.selected.filter(id => id !== action.payload)
        : [...state.selected, action.payload]
      return { ...state, selected }
    }
    case UI_REPLACE_ACTIVE: {
      const openItems = state.drawers.filter(drawer => drawer.open)
      const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
      const newItem: DrawerData = {
        id: lastItem ? lastItem.id : generateItemId(),
        open: true,
        ...action.payload,
      }
      const drawers = [...state.drawers]
      if (lastItem) {
        drawers[drawers.indexOf(lastItem)] = newItem
      } else {
        drawers.push(newItem)
      }
      return { ...state, drawers }
    }
    case UI_UPDATE_ACTIVE: {
      const openItems = state.drawers.filter(drawer => drawer.open)
      const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
      const newItem: DrawerData = {
        id: generateItemId(),
        open: true,
        ...lastItem,
        ...action.payload,
      }
      const drawers = [...state.drawers]
      drawers[drawers.length - 1] = newItem
      return { ...state, drawers }
    }
    case UI_PUSH_ACTIVE:
      return {
        ...state,
        drawers: [
          ...state.drawers,
          {
            id: generateItemId(),
            open: true,
            ...action.payload,
          },
        ],
      }
    case UI_REMOVE_ACTIVE:
      return {
        ...state,
        drawers: state.drawers.slice(0, -1),
      }
    case UI_CLEAR_DRAWERS:
      return {
        ...state,
        drawers: [],
      }
    case UI_PRUNE_ITEM_DRAWERS: {
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
      return {
        ...state,
        drawers: modified ? newDrawers : state.drawers,
        selected: state.selected.filter(id => !action.payload.includes(id)),
      }
    }
    default:
      return state
  }
}

export default reduceUi

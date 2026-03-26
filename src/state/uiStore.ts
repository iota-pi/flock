import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AlertColor } from '@mui/material'
import { generateItemId } from '../utils'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../utils/customFilter'
import type { ItemId, Item } from './items'

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
  dlqCount: number,
  drawers: DrawerData[],
  filters: FilterCriterion[],
  message: UIMessage | null,
  requests: RequestData,
  selected: ItemId[],
  justCreatedAccount: boolean,
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

export interface UiStore extends UIState {
  setUi: (payload: SetUiPayload) => void,
  setDlqCount: (count: number) => void,
  startRequest: () => void,
  finishRequest: (error?: string) => void,
  setMessage: (payload: BaseUIMessage) => void,
  toggleSelected: (itemId: ItemId) => void,
  replaceActive: (payload: Partial<Omit<DrawerData, 'id'>>) => void,
  updateActive: (payload: Partial<Omit<DrawerData, 'id'>>) => void,
  pushActive: (payload: PushActiveData) => void,
  removeActive: () => void,
  clearDrawers: () => void,
  pruneItemDrawers: (itemIds: ItemId[]) => void,
}

const initialUiState: UIState = {
  darkMode: null,
  dlqCount: 0,
  drawers: [],
  filters: DEFAULT_FILTER_CRITERIA,
  message: null,
  requests: {
    active: 0,
  },
  selected: [],
  justCreatedAccount: false,
}

export const useUiStore = create<UiStore>()(
  persist(
    set => ({
      ...initialUiState,
      setUi: payload => {
        set(state => ({
          ...payload,
          dlqCount: payload.dlqCount ?? state.dlqCount,
          requests: {
            ...state.requests,
            ...payload.requests,
          },
        }))
      },
      setDlqCount: count => {
        set(() => ({ dlqCount: Math.max(0, count) }))
      },
      startRequest: () => {
        set(state => ({
          requests: { active: state.requests.active + 1 },
        }))
      },
      finishRequest: error => {
        set(state => ({
          requests: { active: Math.max(0, state.requests.active - 1) },
          message: error
            ? { severity: 'error', message: error }
            : state.message,
        }))
      },
      setMessage: payload => {
        set(() => ({
          message: {
            severity: payload.severity || 'success',
            message: payload.message,
          },
        }))
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
          const openItems = state.drawers.filter(drawer => drawer.open)
          const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
          const newItem: DrawerData = {
            id: lastItem ? lastItem.id : generateItemId(),
            open: true,
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
      updateActive: payload => {
        set(state => {
          const openItems = state.drawers.filter(drawer => drawer.open)
          const lastItem = openItems.length > 0 ? openItems[openItems.length - 1] : undefined
          const newItem: DrawerData = {
            id: generateItemId(),
            open: true,
            ...lastItem,
            ...payload,
          }
          const drawers = [...state.drawers]
          drawers[drawers.length - 1] = newItem
          return { drawers }
        })
      },
      pushActive: payload => {
        set(state => ({
          drawers: [
            ...state.drawers,
            {
              id: generateItemId(),
              open: true,
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
        set(() => ({
          drawers: [],
        }))
      },
      pruneItemDrawers: itemIds => {
        set(state => {
          const newDrawers: typeof state.drawers = []
          let modified = false
          for (const drawer of state.drawers) {
            if (drawer.item && itemIds.includes(drawer.item)) {
              modified = true
            } else if (drawer.next && drawer.next.find(item => !itemIds.includes(item))) {
              newDrawers.push({
                ...drawer,
                next: drawer.next.filter(item => !itemIds.includes(item)),
              })
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
    }),
    {
      name: 'flock-ui-storage',
      partialize: state => ({ darkMode: state.darkMode }),
    },
  ),
)

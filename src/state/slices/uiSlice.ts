import type { StateCreator } from 'zustand'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../../utils/customFilter'
import { getOnlineState } from '@vault/client'
import type { AppStore } from '../store'

export interface UIState {
  activeRequests: number
  appUpdateReady: boolean
  darkMode: boolean | null
  filters: FilterCriterion[]
  justCreatedAccount: boolean
  showArchived: boolean
}

type SetUiPayload = Partial<UIState>

export interface UiSlice extends UIState {
  setAppUpdateReady: (ready: boolean) => void
  setUi: (payload: SetUiPayload) => void
  startRequest: () => void
  finishRequest: (error?: string) => void
}

const initialUiState: UIState = {
  activeRequests: 0,
  appUpdateReady: false,
  darkMode: null,
  filters: DEFAULT_FILTER_CRITERIA,
  justCreatedAccount: false,
  showArchived: false,
}

export const createUiSlice: StateCreator<
  AppStore,
  [],
  [],
  UiSlice
> = (set, get) => ({
  ...initialUiState,
  setAppUpdateReady: ready => set({ appUpdateReady: ready }),
  setUi: payload => {
    set(() => ({ ...payload }))
  },
  startRequest: () => {
    set(state => ({
      activeRequests: state.activeRequests + 1,
    }))
  },
  finishRequest: error => {
    set(state => ({
      activeRequests: Math.max(0, state.activeRequests - 1),
    }))

    if (error && getOnlineState()) {
      get().setMessage({
        severity: 'error',
        message: error,
      })
    }
  },
})

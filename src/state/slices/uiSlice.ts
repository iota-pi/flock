import type { StateCreator } from 'zustand'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../../utils/customFilter'
import type { AppStore } from '../store'

export interface UIState {
  activeRequests: number
  darkMode: boolean | null
  filters: FilterCriterion[]
  justCreatedAccount: boolean
}

type SetUiPayload = Partial<UIState>

export interface UiSlice extends UIState {
  setUi: (payload: SetUiPayload) => void
  startRequest: () => void
  finishRequest: (error?: string) => void
}

const initialUiState: UIState = {
  activeRequests: 0,
  darkMode: null,
  filters: DEFAULT_FILTER_CRITERIA,
  justCreatedAccount: false,
}

export const createUiSlice: StateCreator<
  AppStore,
  [],
  [],
  UiSlice
> = (set, get) => ({
  ...initialUiState,
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

    if (error) {
      get().setMessage({
        severity: 'error',
        message: error,
      })
    }
  },
})

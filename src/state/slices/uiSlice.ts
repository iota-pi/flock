import type { StateCreator } from 'zustand'
import { DEFAULT_FILTER_CRITERIA, type FilterCriterion } from '../../utils/customFilter'
import { getOnlineState } from '@vault/client'
import type { AppStore } from '../store'

export interface UIState {
  activeRequests: number
  appUpdateReady: boolean
  /** The user chose to update later, so the prompt stays hidden (Settings still offers it) */
  appUpdateDismissed: boolean
  darkMode: boolean | null
  /**
   * Whether the delete account dialog is open. It lives in the store, and the dialog in App, because
   * deleting stops sync, which replaces the page (and anything mounted in it) with a spinner.
   */
  deleteAccountOpen: boolean
  filters: FilterCriterion[]
  justCreatedAccount: boolean
  showArchived: boolean
}

type SetUiPayload = Partial<UIState>

export interface UiSlice extends UIState {
  setAppUpdateReady: (ready: boolean) => void
  dismissAppUpdate: () => void
  setUi: (payload: SetUiPayload) => void
  startRequest: () => void
  finishRequest: (error?: string) => void
}

const initialUiState: UIState = {
  activeRequests: 0,
  appUpdateReady: false,
  appUpdateDismissed: false,
  darkMode: null,
  deleteAccountOpen: false,
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
  // A newer version prompts again, even if the user put off the last one
  setAppUpdateReady: ready => set({ appUpdateReady: ready, appUpdateDismissed: false }),
  dismissAppUpdate: () => set({ appUpdateDismissed: true }),
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

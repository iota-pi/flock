import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../utils/customFilter'
import { useToastStore } from './toastStore'

export interface UIState {
  activeRequests: number,
  darkMode: boolean | null,
  filters: FilterCriterion[],
  justCreatedAccount: boolean,
}

type SetUiPayload = Partial<UIState>

interface UiStore extends UIState {
  setUi: (payload: SetUiPayload) => void,
  startRequest: () => void,
  finishRequest: (error?: string) => void,
}

const initialUiState: UIState = {
  activeRequests: 0,
  darkMode: null,
  filters: DEFAULT_FILTER_CRITERIA,
  justCreatedAccount: false,
}

export const useUiStore = create<UiStore>()(
  persist(
    set => ({
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
          useToastStore.getState().setMessage({
            severity: 'error',
            message: error,
          })
        }
      },
    }),
    {
      name: 'flock-ui-storage',
      partialize: state => ({ darkMode: state.darkMode }),
    },
  ),
)

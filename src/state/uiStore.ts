import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_FILTER_CRITERIA, FilterCriterion } from '../utils/customFilter'
import { useToastStore } from './toastStore'

export interface RequestData {
  active: number,
}

export interface UIState {
  darkMode: boolean | null,
  filters: FilterCriterion[],
  requests: RequestData,
  justCreatedAccount: boolean,
}

export type SetUiPayload = Omit<Partial<UIState>, 'requests'> & {
  requests?: Partial<UIState['requests']>,
}

export interface UiStore extends UIState {
  setUi: (payload: SetUiPayload) => void,
  startRequest: () => void,
  finishRequest: (error?: string) => void,
}

const initialUiState: UIState = {
  darkMode: null,
  filters: DEFAULT_FILTER_CRITERIA,
  requests: {
    active: 0,
  },
  justCreatedAccount: false,
}

export const useUiStore = create<UiStore>()(
  persist(
    set => ({
      ...initialUiState,
      setUi: payload => {
        set(state => ({
          ...payload,
          requests: {
            ...state.requests,
            ...payload.requests,
          },
        }))
      },
      startRequest: () => {
        set(state => ({
          requests: { active: state.requests.active + 1 },
        }))
      },
      finishRequest: error => {
        set(state => ({
          requests: { active: Math.max(0, state.requests.active - 1) },
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

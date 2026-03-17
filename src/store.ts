import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  initialState as initialUiState,
} from './state/ui'
import {
  initialState as initialAccountState,
} from './state/account'
import {
  clearDrawersState,
  finishRequestState,
  pruneItemDrawersState,
  pushActiveState,
  removeActiveState,
  replaceActiveState,
  setMessageState,
  setUiState,
  startRequestState,
  toggleSelectedState,
  updateActiveState,
} from './state/storeActions/uiActions'
import {
  setAccountState,
} from './state/storeActions/accountActions'
import {
  reduceUi,
} from './state/ui'
import type { AccountState } from './state/account'
import type {
  BaseUIMessage,
  DrawerData,
  PushActiveData,
  SetUiPayload,
  UIState,
} from './state/ui'
import type { ItemId } from './state/items'

export interface RootState {
  account: AccountState,
  ui: UIState,
}

export interface AppActions {
  setAccount: (payload: Partial<AccountState>) => void,
  setUi: (payload: SetUiPayload) => void,
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

type StoreState = RootState & {
  actions: AppActions,
}

function mapUiState(current: StoreState, nextUi: UIState): StoreState {
  return nextUi === current.ui ? current : { ...current, ui: nextUi }
}

const appStore = createStore<StoreState>()((set) => ({
  account: initialAccountState,
  ui: initialUiState,
  actions: {
    setAccount: (payload) => {
      set((current) => {
        const nextAccount = setAccountState(current.account, payload)
        const nextUi = current.ui
        if (nextAccount === current.account) {
          return current
        }

        import('./api/client').then(({ queryClient, queryKeys }) => {
          queryClient.setQueryData(queryKeys.account, nextAccount)
        })

        return {
          ...current,
          account: nextAccount,
          ui: nextUi,
        }
      })
    },
    setUi: (payload) => {
      set((current) => {
        return mapUiState(current, setUiState(current.ui, payload))
      })
    },
    startRequest: () => {
      set((current) => {
        return mapUiState(current, startRequestState(current.ui))
      })
    },
    finishRequest: (error) => {
      set((current) => {
        return mapUiState(current, finishRequestState(current.ui, error))
      })
    },
    setMessage: (payload) => {
      set((current) => {
        return mapUiState(current, setMessageState(current.ui, payload))
      })
    },
    toggleSelected: (itemId) => {
      set((current) => {
        return mapUiState(current, toggleSelectedState(current.ui, itemId))
      })
    },
    replaceActive: (payload) => {
      set((current) => {
        return mapUiState(current, replaceActiveState(current.ui, payload))
      })
    },
    updateActive: (payload) => {
      set((current) => {
        return mapUiState(current, updateActiveState(current.ui, payload))
      })
    },
    pushActive: (payload) => {
      set((current) => {
        return mapUiState(current, pushActiveState(current.ui, payload))
      })
    },
    removeActive: () => {
      set((current) => {
        return mapUiState(current, removeActiveState(current.ui))
      })
    },
    clearDrawers: () => {
      set((current) => {
        return mapUiState(current, clearDrawersState(current.ui))
      })
    },
    pruneItemDrawers: (itemIds) => {
      set((current) => {
        return mapUiState(current, pruneItemDrawersState(current.ui, itemIds))
      })
    },
  },
}))

function getState(): RootState {
  const { account, ui } = appStore.getState()
  return { account, ui }
}

function subscribe(listener: () => void) {
  return appStore.subscribe(listener)
}

function getActions(): AppActions {
  return appStore.getState().actions
}

const store = {
  actions: {
    setAccount: (payload: Partial<AccountState>) => getActions().setAccount(payload),
    setUi: (payload: SetUiPayload) => getActions().setUi(payload),
    startRequest: () => getActions().startRequest(),
    finishRequest: (error?: string) => getActions().finishRequest(error),
    setMessage: (payload: BaseUIMessage) => getActions().setMessage(payload),
    toggleSelected: (itemId: ItemId) => getActions().toggleSelected(itemId),
    replaceActive: (payload: Partial<Omit<DrawerData, 'id'>>) => getActions().replaceActive(payload),
    updateActive: (payload: Partial<Omit<DrawerData, 'id'>>) => getActions().updateActive(payload),
    pushActive: (payload: PushActiveData) => getActions().pushActive(payload),
    removeActive: () => getActions().removeActive(),
    clearDrawers: () => getActions().clearDrawers(),
    pruneItemDrawers: (itemIds: ItemId[]) => getActions().pruneItemDrawers(itemIds),
  },
  getState,
  subscribe,
}

export default store

export function useAppActions(): AppActions {
  return useStore(appStore, state => state.actions)
}

export function useAppSelector<T>(selector: (state: RootState) => T): T {
  return useStore(appStore, selector as (state: StoreState) => T)
}

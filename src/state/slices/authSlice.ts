import type { StateCreator } from 'zustand'
import type { AppStore } from '../store'

type AccountId = string

interface AccountState {
  account: AccountId
  loggedIn: boolean
  initializing: boolean
}

export interface AuthSlice extends AccountState {
  updateAuth: (payload: Partial<AccountState>) => void
}

const initialAuthState: AccountState = {
  account: '',
  loggedIn: false,
  initializing: true,
}

export const createAuthSlice: StateCreator<
  AppStore,
  [],
  [],
  AuthSlice
> = set => ({
  ...initialAuthState,
  updateAuth: payload => set(() => ({ ...payload })),
})

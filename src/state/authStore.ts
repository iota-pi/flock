import { create } from 'zustand'

export type AccountId = string

export interface AccountState {
  account: AccountId,
  loggedIn: boolean,
  initializing: boolean,
}

const initialAuthState: AccountState = {
  account: '',
  loggedIn: false,
  initializing: true,
}

type AuthStore = AccountState & {
  setAccount: (payload: Partial<AccountState>) => void,
}

export const useAuthStore = create<AuthStore>(set => ({
  ...initialAuthState,
  setAccount: payload => {
    set(previous => ({
      ...previous,
      ...payload,
    }))
  },
}))

export function getInitialAuthState(): AccountState {
  return initialAuthState
}
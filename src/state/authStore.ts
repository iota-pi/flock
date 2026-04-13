import { create } from 'zustand'

type AccountId = string

interface AccountState {
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
  updateAuth: (payload: Partial<AccountState>) => void,
}

export const useAuthStore = create<AuthStore>(set => ({
  ...initialAuthState,
  updateAuth: payload => set(payload),
}))

export function getInitialAuthState(): AccountState {
  return initialAuthState
}

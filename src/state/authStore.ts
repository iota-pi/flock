import { create } from 'zustand'
import { syncDB } from '../api/db'
import { ACTIVE_SESSION_TOKEN_KEY } from '../sync/sessionTokenStore'

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

export async function clearPersistedAuthSyncState(): Promise<void> {
  await syncDB.removeItem(ACTIVE_SESSION_TOKEN_KEY)
}
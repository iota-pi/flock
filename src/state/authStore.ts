import { create } from 'zustand'
import { syncDB } from '../api/db'
import { ACTIVE_SESSION_TOKEN_KEY, OFFLINE_QUEUE_KEY } from '../sync/offlineQueueStore'

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

export async function clearPersistedAuthSyncState(): Promise<void> {
  await syncDB.removeItem(ACTIVE_SESSION_TOKEN_KEY)
  await syncDB.removeItem(OFFLINE_QUEUE_KEY)
}
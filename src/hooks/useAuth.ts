import { useMemo } from 'react'
import { useAuthStore } from '../state/authStore'

export function useAuth() {
  const account = useAuthStore(state => state.account)
  const loggedIn = useAuthStore(state => state.loggedIn)
  const initializing = useAuthStore(state => state.initializing)

  return useMemo(
    () => ({
      account,
      loggedIn,
      initializing,
    }),
    [account, initializing, loggedIn],
  )
}
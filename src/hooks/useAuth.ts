import { useMemo } from 'react'
import { useAccountQuery } from '../api/queries'

export function useAuth() {
  const { data } = useAccountQuery()

  return useMemo(
    () => ({
      account: data?.account || '',
      loggedIn: !!data?.loggedIn,
      initializing: data?.initializing ?? true,
    }),
    [data?.account, data?.initializing, data?.loggedIn],
  )
}
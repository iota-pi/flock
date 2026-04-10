import { ReactNode, useEffect } from 'react'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { RepoContext } from '@automerge/automerge-repo-react-hooks'
import AppInitializer from './AppInitializer'
import { useAuthStore } from '../state/authStore'
import { getAutomergeRepo, setVaultNetworkAccount } from '../sync/automergeRepo'

type AppProvidersProps = {
  children: ReactNode
}

export default function AppProviders({ children }: AppProvidersProps) {
  const account = useAuthStore(state => state.account)
  const loggedIn = useAuthStore(state => state.loggedIn)

  useEffect(() => {
    setVaultNetworkAccount(loggedIn ? account : null)
  }, [account, loggedIn])

  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <RepoContext.Provider value={getAutomergeRepo()}>
        <AppInitializer />
        {children}
      </RepoContext.Provider>
    </LocalizationProvider>
  )
}
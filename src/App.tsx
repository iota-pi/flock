import { useCallback, useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router'
import { styled, Toolbar, useMediaQuery } from '@mui/material'
import { Theme } from '@mui/material/styles'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import { httpBatchLink } from '@trpc/client'
import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import { routes } from './components/pages'
import { useLoggedIn } from './state/selectors'
import MainLayout from './components/layout/MainLayout'
import { loadVault } from './api/VaultLazy'
import ErrorPage from './components/pages/ErrorPage'
import env from './env'
import { trpc } from './api/trpc'
import { queryClient } from './api/queryClient'
import { getApiAuthToken, trackedFetch } from './api/runtime'
import { initialiseDeadLetterQueueCount, processOfflineQueue } from './api/offlineQueue'

const Root = styled('div')({
  display: 'flex',
  height: '100vh',
})
const Content = styled('div')({
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
})

function RootLayout() {
  const loggedIn = useLoggedIn()
  const small = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'))

  const [rawMiniMenu, setMiniMenu] = useState<boolean>()
  const [rawOpenMenu, setOpenMenu] = useState<boolean>()
  const defaultMini = small
  const defaultOpen = !xs
  const miniMenu = rawMiniMenu === undefined ? defaultMini : rawMiniMenu
  const openMenu = rawOpenMenu === undefined ? defaultOpen : rawOpenMenu

  const handleToggleMiniMenu = useCallback(
    () => setMiniMenu(m => (
      m !== undefined && miniMenu !== defaultMini ? undefined : !miniMenu
    )),
    [defaultMini, miniMenu],
  )
  const handleToggleShowMenu = useCallback(
    () => setOpenMenu(o => (
      o !== undefined && openMenu !== defaultOpen ? undefined : !openMenu
    )),
    [defaultOpen, openMenu],
  )
  const handleMenuClick = useCallback(
    () => {
      if (xs) {
        setOpenMenu(undefined)
      }
    },
    [xs],
  )

  useEffect(
    () => {
      const handleOnline = () => {
        void processOfflineQueue()
      }

      void (async () => {
        await loadVault()
        await initialiseDeadLetterQueueCount()
        await processOfflineQueue()
      })()

      window.addEventListener('online', handleOnline)

      return () => {
        window.removeEventListener('online', handleOnline)
      }
    },
    [],
  )

  return (
    <Root>
      {loggedIn && (
        <>
          <AppBar
            minimisedMenu={miniMenu}
            onToggleMenu={handleToggleShowMenu}
          />
          <MainMenu
            minimised={miniMenu}
            open={openMenu}
            onClick={handleMenuClick}
            onMinimise={handleToggleMiniMenu}
          />
        </>
      )}

      <Content>
        {loggedIn && (
          <Toolbar />
        )}

        <MainLayout>
          <Outlet />
        </MainLayout>
      </Content>
    </Root>
  )
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    children: routes,
  }
])

export default function App() {
  const [trpcClient] = useState(() => trpc.createClient({
    links: [
      httpBatchLink({
        url: `${env.VAULT_ENDPOINT}/trpc`,
        headers: () => {
          const authToken = getApiAuthToken()
          return authToken ? { Authorization: `Basic ${authToken}` } : {}
        },
        fetch: trackedFetch,
      }),
    ],
  }))

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        <RouterProvider router={router} />
      </LocalizationProvider>
    </trpc.Provider>
  )
}

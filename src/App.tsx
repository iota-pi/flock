import { useCallback, useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router'
import { styled, Toolbar, useMediaQuery } from '@mui/material'
import { Theme } from '@mui/material/styles'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import { routes } from './components/pages'
import { useLoggedIn } from './state/selectors'
import { useAuthStore } from './state/authStore'
import MainLayout from './components/layout/MainLayout'
import { loadVault } from './api/vault'
import { ensureItemsBootstrap } from './api/itemReadService'
import ErrorPage from './components/pages/ErrorPage'
import { startSyncCoordinator, stopSyncCoordinator } from './sync/syncCoordinator'

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
  const account = useAuthStore(state => state.account)
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

  useEffect(() => {
    void loadVault()
  }, [])

  useEffect(() => {
    if (!loggedIn || !account) {
      stopSyncCoordinator()
      return
    }

    void ensureItemsBootstrap(account).catch(() => undefined)
    startSyncCoordinator({ account })

    return () => {
      stopSyncCoordinator()
    }
  }, [account, loggedIn])

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
  return (
    <LocalizationProvider dateAdapter={AdapterDateFns}>
      <RouterProvider router={router} />
    </LocalizationProvider>
  )
}

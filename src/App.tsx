import { useCallback, useEffect, useState } from 'react'
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  styled,
  Toolbar,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { Theme } from '@mui/material/styles'
import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import { routes } from './components/pages'
import { useLoggedIn } from './state/selectors'
import { useAuthStore } from './state/authStore'
import { useDataStore } from './state/dataStore'
import { SyncBridge } from './sync/SyncBridge'
import { useSyncStore } from './state/syncStore'
import MainLayout from './components/layout/MainLayout'
import ErrorPage from './components/pages/ErrorPage'
import AppProviders from './app/AppProviders'

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
  const accountId = useAuthStore(state => state.account)
  const dataStatus = useDataStore(state => state.status)
  const syncWarning = useSyncStore(state => state.syncWarning)
  const clearSyncWarning = useSyncStore(state => state.clearSyncWarning)
  const small = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'))

  const [rawMiniMenu, setMiniMenu] = useState<boolean>()
  const [rawOpenMenu, setOpenMenu] = useState<boolean>()
  const defaultMini = small
  const defaultOpen = !xs
  const miniMenu = rawMiniMenu === undefined ? defaultMini : rawMiniMenu
  const openMenu = rawOpenMenu === undefined ? defaultOpen : rawOpenMenu

  useEffect(() => {
    if (loggedIn && accountId) {
      SyncBridge.initialize(accountId).catch(console.error)
    }
  }, [loggedIn, accountId])

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

  if (loggedIn && dataStatus === 'initializing') {
    return (
      <Box sx={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

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

        {syncWarning && (
          <Alert
            severity="warning"
            onClose={clearSyncWarning}
            sx={{ m: 2, mb: 0 }}
          >
            {syncWarning}
          </Alert>
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

function FatalError({ fatalError }: { fatalError: string }) {
  return (
    <Root>
      <Container maxWidth="sm">
        <Typography variant="h4" gutterBottom>
          Fatal Error
        </Typography>

        <Typography color="error" sx={{ mt: 1 }}>
          {fatalError}
        </Typography>

        <Box sx={{ mt: 3 }}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => window.location.reload()}
          >
            Reload Page
          </Button>
        </Box>
      </Container>
    </Root>
  )
}

export default function App() {
  const fatalError = useSyncStore(state => state.fatalError)

  if (fatalError) {
    return <FatalError fatalError={fatalError} />
  }

  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

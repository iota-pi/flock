import { useCallback, useState } from 'react'
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router'
import { Theme, styled } from '@mui/material/styles'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'

import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import { routes } from './components/pages'
import { useLoggedIn } from './state/selectors'
import { useAppStore } from './state/store'
import MainLayout from './components/layout/MainLayout'
import ErrorPage from './components/pages/ErrorPage'
import AppProviders from './app/AppProviders'
import AppInitializer from './app/AppInitializer'
import BiometricPrompt from './components/BiometricPrompt'
import useAutoLock from './hooks/useAutoLock'


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
  useAutoLock()
  const syncWarning = useAppStore(state => state.syncWarning)
  const clearSyncWarning = useAppStore(state => state.clearSyncWarning)
  const small = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'))
  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'))

  const [rawMiniMenu, setMiniMenu] = useState<boolean>()
  const [rawOpenMenu, setOpenMenu] = useState<boolean>()
  const defaultMini = small && !xs
  const defaultOpen = !xs
  const miniMenu = rawMiniMenu === undefined ? defaultMini : rawMiniMenu
  const openMenu = rawOpenMenu === undefined ? defaultOpen : rawOpenMenu
  const floatingMenu = xs

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
      if (floatingMenu) {
        setOpenMenu(undefined)
      }
    },
    [floatingMenu],
  )

  return (
    <Root>
      <AppInitializer />
      {loggedIn && <BiometricPrompt />}
      {loggedIn && (
        <>
          <AppBar
            minimisedMenu={miniMenu}
            onToggleMenu={handleToggleShowMenu}
          />
          <MainMenu
            floating={floatingMenu}
            minimised={miniMenu}
            open={openMenu}
            onClick={handleMenuClick}
            onClose={handleMenuClick}
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
  const fatalError = useAppStore(state => state.fatalError)

  if (fatalError) {
    return <FatalError fatalError={fatalError} />
  }

  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}

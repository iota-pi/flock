import { useCallback, useEffect, useState } from 'react'
import { BrowserRouter as Router } from 'react-router-dom'
import { styled, Toolbar, useMediaQuery } from '@mui/material'
import { Theme } from '@mui/material/styles'
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns'
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider'
import AppBar from './components/layout/AppBar'
import MainMenu from './components/layout/MainMenu'
import PageView from './components/pages'
import { useLoggedIn } from './state/selectors'
import MainLayout from './components/layout/MainLayout'
import { loadVault } from './api/Vault'

const Root = styled('div')({
  display: 'flex',
  height: '100vh',
})
const Content = styled('div')({
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
})

export default function App() {
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
      loadVault()
    },
    [],
  )

  return (
    <>
      <LocalizationProvider dateAdapter={AdapterDateFns}>
        <Router>
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
                <PageView />
              </MainLayout>
            </Content>
          </Root>
        </Router>
      </LocalizationProvider>
    </>
  )
}

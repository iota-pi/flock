import { Theme, useMediaQuery } from '@mui/material'
import { useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { DrawerData, useNavigationStore } from 'src/state/navigationStore'
import { useLoggedIn } from 'src/state/selectors'
import { usePrevious } from 'src/utils'
import { usePage } from '../pages'
import ItemDrawer from 'src/features/items/components/ItemDrawer'
import PlaceholderDrawer from '../drawers/Placeholder'

const noop = () => {}

function getDrawerItemId(drawer?: DrawerData | null): string | null {
  return drawer?.item ?? null
}

function isHashRoutedDrawer(drawer: DrawerData | null): boolean {
  if (!drawer) return false
  return drawer.disableRouting !== true
}

function useDrawerRouting(activeDrawer: DrawerData | null) {
  const setDrawer = useNavigationStore(state => state.setDrawer)
  const removeActive = useNavigationStore(state => state.removeDrawer)
  const routerLocation = useLocation()
  const navigate = useNavigate()

  const isHashRouted = isHashRoutedDrawer(activeDrawer)
  const prevPathname = usePrevious(routerLocation.pathname)
  const prevLocationHash = usePrevious(routerLocation.hash)

  useEffect(
    () => {
      if (prevPathname && prevPathname !== routerLocation.pathname && activeDrawer) {
        removeActive()
      }
    },
    [activeDrawer, prevPathname, removeActive, routerLocation.pathname],
  )

  const prevDrawer = usePrevious(activeDrawer)

  useEffect(
    () => {
      const activeItemId = getDrawerItemId(activeDrawer)
      const prevItemId = getDrawerItemId(prevDrawer)
      const currentHash = routerLocation.hash.replace(/^#/, '')
      const prevHash = prevLocationHash?.replace(/^#/, '')

      // Drawer was opened or its item changed programmatically
      if (activeDrawer && activeDrawer !== prevDrawer) {
        if (isHashRouted && activeItemId && activeItemId !== currentHash) {
          const replace = !!prevHash
          navigate(`#${activeItemId}`, { replace })
        }
      }
      // Drawer was closed programmatically (and it was hash routed)
      else if (!activeDrawer && prevDrawer && isHashRoutedDrawer(prevDrawer)) {
        if (currentHash === prevItemId) {
          navigate(-1)
        }
      }
      // URL Hash changed by user navigation (e.g. back button or link)
      else if (currentHash !== prevHash) {
        if (currentHash) {
          if (currentHash !== activeItemId) {
            setDrawer({ item: currentHash })
          }
        } else if (isHashRouted) {
          removeActive()
        }
      }
    },
    [activeDrawer, isHashRouted, navigate, prevDrawer, prevLocationHash, removeActive, routerLocation.hash, setDrawer],
  )
}

function DrawerDisplay() {
  const removeActive = useNavigationStore(state => state.removeDrawer)
  const drawer = useNavigationStore(state => state.drawer)
  const loggedIn = useLoggedIn()
  const page = usePage()

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'))

  const handleClose = useCallback(
    () => {
      if (!drawer) {
        return
      }

      removeActive()
    },
    [drawer, removeActive],
  )

  const lookupItemId = useMemo(
    () => getDrawerItemId(drawer),
    [drawer],
  )

  useDrawerRouting(drawer)

  const open = drawer ? (drawer.open ?? true) : false

  const showPlaceholder = (
    loggedIn
    && !drawer
    && baseDrawerIsPermanent
    && !page?.noPlaceholderDrawer
  )

  return (
    showPlaceholder ? (
      <PlaceholderDrawer
        open
        onClose={noop}
      />
    ) : (
      <ItemDrawer
        alwaysTemporary={drawer?.alwaysTemporary}
        fromPrayerPage={drawer?.fromPrayerPage}
        itemId={lookupItemId}
        initialItem={drawer?.initialItem}
        onBack={handleClose}
        onClose={handleClose}
        open={open}
      />
    )
  )
}

export default DrawerDisplay

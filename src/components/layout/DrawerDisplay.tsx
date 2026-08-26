import { useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'

import { useAppStore } from 'src/state/store'
import type { DrawerData } from 'src/state/slices/navigationSlice'
import { useLoggedIn } from 'src/state/selectors'
import { usePrevious } from 'src/utils'
import { usePage } from '../pages'
import ItemDrawer from 'src/features/items/components/ItemDrawer'
import PlaceholderDrawer from '../drawers/Placeholder'
import { ItemId } from 'src/shared/schemas/items'


const noop = () => {}

function getDrawerItemId(drawer?: DrawerData | null): ItemId | null {
  return drawer?.item ?? null
}

function isHashRoutedDrawer(drawer: DrawerData | null): boolean {
  if (!drawer) return false
  return drawer.disableRouting !== true
}

function useDrawerRouting(activeDrawer: DrawerData | null) {
  const setDrawer = useAppStore(state => state.setDrawer)
  const removeActive = useAppStore(state => state.removeDrawer)
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
          navigate(`#${activeItemId}`, {
            replace,
            state: { ...routerLocation.state, drawerOpened: true },
          })
        }
      }
      // Drawer was closed programmatically (and it was hash routed)
      else if (!activeDrawer && prevDrawer && isHashRoutedDrawer(prevDrawer)) {
        if (currentHash === prevItemId) {
          const state = routerLocation.state as { drawerOpened?: boolean } | null
          if (state?.drawerOpened) {
            navigate(-1)
          } else {
            navigate(routerLocation.pathname + routerLocation.search, { replace: true })
          }
        }
      }
      // URL Hash changed by user navigation (e.g. back button or link)
      else if (currentHash !== prevHash) {
        if (currentHash) {
          if (currentHash !== activeItemId) {
            setDrawer({ item: currentHash as ItemId })
          }
        } else if (isHashRouted) {
          removeActive()
        }
      }
    },
    [
      activeDrawer,
      isHashRouted,
      navigate,
      prevDrawer,
      prevLocationHash,
      removeActive,
      routerLocation.hash,
      routerLocation.pathname,
      routerLocation.search,
      routerLocation.state,
      setDrawer,
    ],
  )
}

function DrawerDisplay() {
  const removeActive = useAppStore(state => state.removeDrawer)
  const drawer = useAppStore(state => state.drawer)
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
  const showDrawer = loggedIn && (
    !!drawer || showPlaceholder
  )

  if (!showDrawer) {
    return null
  }

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
        onBack={handleClose}
        onClose={handleClose}
        open={open}
      />
    )
  )
}

export default DrawerDisplay

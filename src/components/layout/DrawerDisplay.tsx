import { Theme, useMediaQuery } from '@mui/material'
import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { DrawerData, useNavigationStore } from 'src/state/navigationStore'
import { useLoggedIn } from 'src/state/selectors'
import { generateItemId, usePrevious } from 'src/utils'
import { usePage } from '../pages'
import ItemDrawer from 'src/features/items/components/ItemDrawer'

const PlaceholderDrawer = lazy(() => import('../drawers/Placeholder'))
const noop = () => {}

function getDrawerItemId(drawer?: DrawerData | null): string | undefined {
  return drawer?.item
}

function isHashRoutedDrawer(drawer: DrawerData | null): boolean {
  if (!drawer) return false
  return drawer.disableRouting !== true
}

function useDrawerRouting(activeDrawer: DrawerData | null) {
  const setDrawer = useNavigationStore(state => state.setDrawer)
  const removeActive = useNavigationStore(state => state.removeActive)
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

  const prevActiveDrawer = usePrevious(activeDrawer)

  useEffect(
    () => {
      const activeItemId = getDrawerItemId(activeDrawer)
      const prevActiveItemId = getDrawerItemId(prevActiveDrawer)
      const currentHash = routerLocation.hash.replace(/^#/, '')
      const prevHash = prevLocationHash?.replace(/^#/, '')

      // Drawer was opened or its item changed programmatically
      if (activeDrawer && activeDrawer !== prevActiveDrawer) {
        if (isHashRouted && activeItemId && activeItemId !== currentHash) {
          navigate(`#${activeItemId}`)
        }
      }
      // Drawer was closed programmatically (and it was hash routed)
      else if (!activeDrawer && prevActiveDrawer && isHashRoutedDrawer(prevActiveDrawer)) {
        if (currentHash === prevActiveItemId) {
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
    [activeDrawer, isHashRouted, navigate, prevActiveDrawer, prevLocationHash, removeActive, routerLocation.hash, setDrawer],
  )
}

function IndividualDrawer({
  drawer,
  onClose,
  onExited,
}: {
  drawer: DrawerData | null,
  onClose: () => void,
  onExited: () => void,
}) {
  const isPrayerEditDrawer = (
    drawer?.fromPrayerPage === true
    && drawer?.disableRouting === true
    && !!drawer?.onChange
  )
  const lookupItemId = useMemo(
    () => getDrawerItemId(drawer) || generateItemId(),
    [drawer],
  )

  const handlePrayerChange = useCallback(
    (
      data: Parameters<NonNullable<DrawerData['onChange']>>[0],
    ) => {
      drawer?.onChange?.(data)
    },
    [drawer],
  )

  const open = drawer ? (drawer.open ?? true) : false

  if (isPrayerEditDrawer) {
    return (
      <ItemDrawer
        alwaysTemporary={drawer.alwaysTemporary}
        fromPrayerPage={drawer.fromPrayerPage}
        itemId={lookupItemId}
        initialItem={drawer.initialItem}
        onBack={onClose}
        onChange={handlePrayerChange}
        onClose={onClose}
        onExited={onExited}
        open={open}
      />
    )
  }

  return (
    <ItemDrawer
      itemId={lookupItemId}
      initialItem={drawer?.initialItem}
      onBack={onClose}
      onChange={noop}
      onClose={onClose}
      onExited={onExited}
      open={open}
    />
  )
}

function DrawerDisplay() {
  const removeActive = useNavigationStore(state => state.removeActive)
  const activeDrawer = useNavigationStore(state => state.activeDrawer)
  const loggedIn = useLoggedIn()
  const page = usePage()

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'))

  const handleClose = useCallback(
    () => {
      if (!activeDrawer) {
        return
      }

      activeDrawer.onCloseRequest?.()
      removeActive()
    },
    [activeDrawer, removeActive],
  )

  const handleExited = useCallback(
    () => {
      if (activeDrawer) {
        activeDrawer.onExited?.()
      }
    },
    [activeDrawer],
  )

  const onClose = handleClose

  useDrawerRouting(activeDrawer)

  const showPlaceholder = (
    loggedIn
    && !activeDrawer
    && baseDrawerIsPermanent
    && !page?.noPlaceholderDrawer
  )

  return (
    <>
      <IndividualDrawer
        drawer={activeDrawer}
        onClose={onClose}
        onExited={handleExited}
      />

      {showPlaceholder && (
        <Suspense fallback={null}>
          <PlaceholderDrawer
            open
            onClose={noop}
          />
        </Suspense>
      )}
    </>
  )
}

export default DrawerDisplay

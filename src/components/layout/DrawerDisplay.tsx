import { Theme, useMediaQuery } from '@mui/material'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isItem } from 'src/state/items'
import { DrawerData, useNavigationStore } from 'src/state/navigationStore'
import { useLoggedIn } from 'src/state/selectors'
import { generateItemId, usePrevious } from 'src/utils'
import { usePage } from '../pages'
import { useAutomergeItem } from 'src/sync/useAutomerge'

const ItemDrawer = lazy(() => import('src/features/items/components/ItemDrawer'))
const PlaceholderDrawer = lazy(() => import('../drawers/Placeholder'))
const noop = () => {}

function getDrawerItemId(drawer?: DrawerData): string | undefined {
  return drawer?.item
}

function isHashRoutedDrawer(drawer: DrawerData): boolean {
  return drawer.disableRouting !== true
}

function useDrawerRouting(drawers: DrawerData[]) {
  const clearDrawers = useNavigationStore(state => state.clearDrawers)
  const removeActive = useNavigationStore(state => state.removeActive)
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const hashRoutedDrawers = useMemo(
    () => drawers.filter(isHashRoutedDrawer),
    [drawers],
  )
  const prevHashRoutedDrawers = usePrevious(hashRoutedDrawers)
  const prevPathname = usePrevious(routerLocation.pathname)
  const prevLocationHash = usePrevious(routerLocation.hash)

  useEffect(
    () => {
      if (prevPathname && prevPathname !== routerLocation.pathname && drawers.length > 0) {
        clearDrawers()
      }
    },
    [clearDrawers, drawers.length, prevPathname, routerLocation.pathname],
  )

  useEffect(
    () => {
      if (!prevHashRoutedDrawers) {
        return
      }

      const topItem = getDrawerItemId(hashRoutedDrawers[hashRoutedDrawers.length - 1])
      const prevTopItem = getDrawerItemId(prevHashRoutedDrawers[prevHashRoutedDrawers.length - 1])
      const currentHash = routerLocation.hash.replace(/^#/, '')

      if (hashRoutedDrawers.length === prevHashRoutedDrawers.length) {
        if (topItem && topItem !== prevTopItem) {
          navigate(`#${topItem}`, { replace: true })
        }
      } else if (hashRoutedDrawers.length < prevHashRoutedDrawers.length && prevTopItem === currentHash) {
        navigate(-1)
      } else if (hashRoutedDrawers.length > prevHashRoutedDrawers.length && topItem) {
        navigate(`#${topItem}`)
      }
    },
    [hashRoutedDrawers, navigate, prevHashRoutedDrawers, routerLocation],
  )

  useEffect(
    () => {
      if (hashRoutedDrawers.length === 0) {
        return
      }

      const topDrawer = drawers[drawers.length - 1]
      if (!topDrawer || !isHashRoutedDrawer(topDrawer)) {
        return
      }

      const id = routerLocation.hash.replace(/^#/, '')

      const topItemId = getDrawerItemId(topDrawer)
      const secondTopItem = getDrawerItemId(hashRoutedDrawers[hashRoutedDrawers.length - 2])

      if (prevLocationHash !== routerLocation.hash && secondTopItem === id) {
        removeActive()
      } else if (prevLocationHash && !id && drawers.length > 0) {
        // Only close if the hash that was removed matches the current top item
        const prevId = prevLocationHash.replace(/^#/, '')
        if (prevId === topItemId) {
          removeActive()
        }
      }
    },
    [drawers, hashRoutedDrawers, prevLocationHash, removeActive, routerLocation],
  )
}

function IndividualDrawer({
  drawer,
  open,
  onClose,
  onExited,
  stacked,
}: {
  drawer: DrawerData,
  open: boolean,
  onClose: () => void,
  onExited: () => void,
  stacked: boolean,
}) {
  const isPrayerEditDrawer = (
    drawer.fromPrayerPage === true
    && drawer.disableRouting === true
    && !!drawer.onChange
  )
  const lookupItemId = useMemo(
    () => getDrawerItemId(drawer) || generateItemId(),
    [drawer],
  )
  const item = useAutomergeItem(lookupItemId)

  const handlePrayerChange = useCallback(
    (
      data: Parameters<NonNullable<DrawerData['onChange']>>[0],
    ) => {
      drawer.onChange?.(data)
    },
    [drawer],
  )

  if (isPrayerEditDrawer && item) {
    return (
      <Suspense fallback={null}>
        <ItemDrawer
          alwaysTemporary={drawer.alwaysTemporary}
          fromPrayerPage={drawer.fromPrayerPage}
          item={item}
          onBack={onClose}
          onChange={handlePrayerChange}
          onClose={onClose}
          onExited={onExited}
          open={open}
          stacked={drawer.stacked ?? false}
        />
      </Suspense>
    )
  }

  if (item && isItem(item)) {
    return (
      <Suspense fallback={null}>
        <ItemDrawer
          item={item}
          onBack={onClose}
          onChange={noop}
          onClose={onClose}
          onExited={onExited}
          open={open}
          stacked={drawer.stacked ?? stacked}
        />
      </Suspense>
    )
  }

  return null
}

function DrawerDisplay() {
  const removeActive = useNavigationStore(state => state.removeActive)
  const drawers = useNavigationStore(state => state.drawers)
  const loggedIn = useLoggedIn()
  const page = usePage()
  const [closingDrawerId, setClosingDrawerId] = useState<string | null>(null)

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'))
  const topDrawer = drawers[drawers.length - 1]
  const topDrawerId = topDrawer?.id || null
  const activeClosingDrawerId = closingDrawerId && topDrawerId === closingDrawerId
    ? closingDrawerId
    : null

  const handleClose = useCallback(
    () => {
      if (!topDrawerId || !topDrawer) {
        return
      }

      topDrawer.onCloseRequest?.()
      setClosingDrawerId(topDrawerId)
    },
    [topDrawer, topDrawerId],
  )

  const handleExited = useCallback(
    (drawer: DrawerData) => {
      if (closingDrawerId === drawer.id) {
        setClosingDrawerId(null)
      }

      drawer.onExited?.()

      if (drawers[drawers.length - 1]?.id === drawer.id) {
        removeActive()
      }
    },
    [closingDrawerId, drawers, removeActive],
  )

  const handleImmediateClose = useCallback(
    () => {
      if (!topDrawer) {
        return
      }

      topDrawer.onCloseRequest?.()
      topDrawer.onExited?.()
      setClosingDrawerId(null)
      removeActive()
    },
    [removeActive, topDrawer],
  )

  const shouldUseImmediateClose = (
    baseDrawerIsPermanent
    && drawers.length === 1
    && topDrawer?.alwaysTemporary !== true
  )

  const onClose = shouldUseImmediateClose
    ? handleImmediateClose
    : handleClose

  const drawerOpenById = useMemo(() => {
    const result = new Map<string, boolean>()
    for (const drawer of drawers) {
      result.set(
        drawer.id,
        (drawer.open ?? true) && drawer.id !== activeClosingDrawerId,
      )
    }
    return result
  }, [activeClosingDrawerId, drawers])

  useDrawerRouting(drawers)

  const showPlaceholder = (
    loggedIn
    && drawers.length === 0
    && baseDrawerIsPermanent
    && !page?.noPlaceholderDrawer
  )

  return (
    <>
      {drawers.map((drawer, i) => (
        <IndividualDrawer
          key={drawer.id}
          drawer={drawer}
          open={drawerOpenById.get(drawer.id) ?? true}
          onClose={onClose}
          onExited={() => handleExited(drawer)}
          stacked={i > 0}
        />
      ))}

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

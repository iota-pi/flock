import { Theme, useMediaQuery } from '@mui/material'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isItem, Item } from '../../state/items'
import { DrawerData, useNavigationStore } from '../../state/navigationStore'
import { useLoggedIn } from '../../state/selectors'
import { generateItemId, usePrevious } from '../../utils'
import { usePage } from '../pages'
import { useAutomergeItem } from 'src/sync/useAutomerge'

const ItemDrawer = lazy(() => import('../../features/items/components/ItemDrawer'))
const PlaceholderDrawer = lazy(() => import('../drawers/Placeholder'))

function useDrawerRouting(drawers: DrawerData[]) {
  const clearDrawers = useNavigationStore(state => state.clearDrawers)
  const removeActive = useNavigationStore(state => state.removeActive)
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const prevDrawers = usePrevious(drawers)
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
      if (!prevDrawers) {
        return
      }
      const topItem = (
        drawers[drawers.length - 1]?.item
        || drawers[drawers.length - 1]?.newItem?.id
      )
      const prevTopItem = (
        prevDrawers[prevDrawers.length - 1]?.item
        || prevDrawers[prevDrawers.length - 1]?.newItem?.id
      )
      const currentHash = routerLocation.hash.replace(/^#/, '')
      if (drawers.length === prevDrawers.length) {
        if (topItem && topItem !== prevTopItem) {
          navigate(`#${topItem}`, { replace: true })
        }
      } else if (drawers.length < prevDrawers.length && prevTopItem === currentHash) {
        navigate(-1)
      } else if (drawers.length > prevDrawers.length && topItem) {
        navigate(`#${topItem}`)
      }
    },
    [drawers, routerLocation, prevDrawers, navigate],
  )

  useEffect(
    () => {
      const id = routerLocation.hash.replace(/^#/, '')

      const topItem = drawers[drawers.length - 1]
      const topItemId = topItem?.item || topItem?.newItem?.id
      const secondTopItem = drawers[drawers.length - 2]?.item

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
    [drawers, prevLocationHash, removeActive, routerLocation],
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
  const existingItem = useAutomergeItem(drawer.item || generateItemId())
  const item = existingItem || drawer.newItem

  const [localItem, setLocalItem] = useState<Item | undefined>(item)
  const handleChange = useCallback(
    (
      data: Partial<Omit<Item, 'type' | 'id'>> | ((prev: Item) => Item),
    ) => setLocalItem(prevItem => {
      if (prevItem && isItem(prevItem)) {
        if (typeof data === 'function') {
          return data(prevItem)
        }
        return { ...prevItem, ...data } as Item
      }
      return undefined
    }),
    [],
  )

  // Update localItem when item changes
  const [prevItem, setPrevItem] = useState(item)
  if (item !== prevItem) {
    setPrevItem(item)
    setLocalItem(item)
  }

  if (localItem) {
    return (
      <Suspense fallback={null}>
        <ItemDrawer
          item={localItem}
          onBack={onClose}
          onChange={handleChange}
          onClose={onClose}
          onExited={onExited}
          open={open}
          stacked={stacked}
        />
      </Suspense>
    )
  }

  return null
}

const noop = () => {}

function DrawerDisplay() {
  const removeActive = useNavigationStore(state => state.removeActive)
  const drawers = useNavigationStore(state => state.drawers)
  const loggedIn = useLoggedIn()
  const page = usePage()
  const [closingDrawerId, setClosingDrawerId] = useState<string | null>(null)

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'))
  const topDrawerId = drawers[drawers.length - 1]?.id || null
  const activeClosingDrawerId = closingDrawerId && topDrawerId === closingDrawerId
    ? closingDrawerId
    : null

  const handleClose = useCallback(
    () => {
      if (topDrawerId) {
        setClosingDrawerId(topDrawerId)
      }
    },
    [topDrawerId],
  )
  const handleExited = useCallback(
    () => {
      setClosingDrawerId(null)
      removeActive()
    },
    [removeActive],
  )
  const onClose = baseDrawerIsPermanent && drawers.length === 1 ? handleExited : handleClose
  const drawerOpenById = useMemo(() => {
    const result = new Map<string, boolean>()
    for (const drawer of drawers) {
      result.set(drawer.id, drawer.id !== activeClosingDrawerId)
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
          onExited={handleExited}
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

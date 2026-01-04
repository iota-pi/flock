import { Theme, useMediaQuery } from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isItem, Item } from '../../state/items'
import { DrawerData, removeActive, updateActive } from '../../state/ui'
import { useAppDispatch, useAppSelector } from '../../store'
import ItemDrawer from '../drawers/ItemDrawer'
import PlaceholderDrawer from '../drawers/Placeholder'
import { useItem, useLoggedIn } from '../../state/selectors'
import { generateItemId, usePrevious } from '../../utils'
import { usePage } from '../pages'

function useDrawerRouting(drawers: DrawerData[]) {
  const dispatch = useAppDispatch()
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const prevDrawers = usePrevious(drawers)
  const prevLocationHash = usePrevious(routerLocation.hash)

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
        dispatch(removeActive())
      } else if (prevLocationHash && !id && drawers.length > 0) {
        // Only close if the hash that was removed matches the current top item
        const prevId = prevLocationHash.replace(/^#/, '')
        if (prevId === topItemId) {
          dispatch(removeActive())
        }
      }
    },
    [dispatch, drawers, prevLocationHash, routerLocation],
  )
}

function IndividualDrawer({
  drawer,
  onClose,
  onExited,
  stacked,
}: {
  drawer: DrawerData,
  onClose: () => void,
  onExited: () => void,
  stacked: boolean,
}) {
  const existingItem = useItem(drawer.item || generateItemId())
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
      <ItemDrawer
        item={localItem}
        onBack={onClose}
        onChange={handleChange}
        onClose={onClose}
        onExited={onExited}
        open={drawer.open}
        stacked={stacked}
      />
    )
  }

  return null
}

const noop = () => {}

function DrawerDisplay() {
  const dispatch = useAppDispatch()
  const drawers = useAppSelector(state => state.ui.drawers)
  const loggedIn = useLoggedIn()
  const page = usePage()

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'))

  const handleClose = useCallback(
    () => dispatch(updateActive({ open: false })),
    [dispatch],
  )
  const handleExited = useCallback(
    () => dispatch(removeActive()),
    [dispatch],
  )
  const onClose = baseDrawerIsPermanent && drawers.length === 1 ? handleExited : handleClose

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
          onClose={onClose}
          onExited={handleExited}
          stacked={i > 0}
        />
      ))}

      {showPlaceholder && (
        <PlaceholderDrawer
          open
          onClose={noop}
        />
      )}
    </>
  )
}

export default DrawerDisplay

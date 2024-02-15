import { Theme, useMediaQuery } from '@mui/material'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isItem, Item } from '../../state/items'
import { DrawerData, removeActive, updateActive } from '../../state/ui'
import { useAppDispatch, useAppSelector } from '../../store'
import ItemDrawer from '../drawers/ItemDrawer'
import PlaceholderDrawer from '../drawers/Placeholder'
import ReportDrawer from '../drawers/ReportDrawer'
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
    [drawers, routerLocation, prevDrawers],
  )

  const secondTopItem = drawers[drawers.length - 2]?.item
  useEffect(
    () => {
      const id = routerLocation.hash.replace(/^#/, '')
      if (secondTopItem === id) {
        dispatch(removeActive())
      } else if (prevLocationHash && !id && drawers.length > 0) {
        dispatch(removeActive())
      }
    },
    [dispatch, drawers.length, prevLocationHash, routerLocation, secondTopItem],
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

  useEffect(() => setLocalItem(item), [item])

  if (localItem) {
    return drawer.report ? (
      <ReportDrawer
        item={localItem}
        next={drawer.next}
        onBack={onClose}
        onClose={onClose}
        onExited={onExited}
        open={drawer.open}
        praying={drawer.praying}
        stacked={stacked}
      />
    ) : (
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
    && !page.noPlaceholderDrawer
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
          onClose={() => {}}
        />
      )}
    </>
  )
}

export default DrawerDisplay

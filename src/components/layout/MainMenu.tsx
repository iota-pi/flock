import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import Drawer from '@mui/material/Drawer'
import List from '@mui/material/List'
import Toolbar from '@mui/material/Toolbar'
import { styled } from '@mui/material/styles'

import { pages, usePage } from '../pages'
import { ProtectedPageId } from '../pages/types'
import { ContractMenuIcon, ExpandMenuIcon } from '../Icons'
import { useNavigationStore } from 'src/state/navigationStore'
import { MainMenuItem } from './MainMenuItem'
import type { MinimisedProp } from './types'


export const DRAWER_SPACING_FULL = 30
export const DRAWER_SPACING_NARROW = 10

const StyledDrawer = styled(
  Drawer,
  {
    shouldForwardProp: p => p !== 'minimised',
  },
)<MinimisedProp>(
  ({ minimised, open, theme }) => ({
    width: open ? (
      theme.spacing(minimised ? DRAWER_SPACING_NARROW : DRAWER_SPACING_FULL)
    ) : 0,
    flexShrink: 0,
    transition: theme.transitions.create('width'),
    zIndex: theme.zIndex.appBar - 1,

    '& .MuiDrawer-paper': {
      transition: theme.transitions.create('width'),
      width: theme.spacing(minimised ? DRAWER_SPACING_NARROW : DRAWER_SPACING_FULL),
    },
  }),
)
const DrawerContent = styled('div')({
  display: 'flex',
  flexGrow: 1,
  overflowX: 'hidden',
  overflowY: 'auto',
})
const FlexList = styled(List)({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
})

interface Props {
  floating?: boolean,
  minimised?: boolean,
  onClick: () => void,
  onMinimise: () => void,
  open: boolean,
}


function MainMenu({
  floating = false,
  minimised = false,
  onClick,
  onMinimise,
  open,
}: Props) {
  const setSelected = useNavigationStore(state => state.setSelected)
  const navigate = useNavigate()
  const page = usePage()
  const previousPageIdRef = useRef<ProtectedPageId | undefined>(page?.id)
  const currentPageIdRef = useRef<ProtectedPageId | undefined>(page?.id)

  const pagePathById = useMemo(
    () => new Map<ProtectedPageId, string>(pages.map(menuPage => [menuPage.id, menuPage.path])),
    [],
  )

  useEffect(
    () => {
      currentPageIdRef.current = page?.id
    },
    [page?.id],
  )

  useEffect(
    () => {
      const previousPageId = previousPageIdRef.current
      const currentPageId = page?.id

      previousPageIdRef.current = currentPageId

      if (!previousPageId || !currentPageId || previousPageId === currentPageId) {
        return
      }

      if (useNavigationStore.getState().selected.length > 0) {
        setSelected([])
      }
    },
    [page?.id, setSelected],
  )

  const handleClick = useCallback(
    (pageId?: ProtectedPageId) => {
      const currentPageId = currentPageIdRef.current

      if (pageId && currentPageId !== pageId) {
        const nextPath = pagePathById.get(pageId)
        if (nextPath) {
          navigate(nextPath)
        }
      } else if (pageId === 'prayer' && currentPageId === 'prayer') {
        navigate('/', {
          replace: true,
          state: {
            resetPrayerAt: Date.now(),
          },
        })
      }
      onClick()
    },
    [navigate, onClick, pagePathById],
  )

  return (
    <StyledDrawer
      minimised={minimised}
      open={open}
      variant={floating ? 'temporary' : 'permanent'}
    >
      <Toolbar />
      <DrawerContent>
        <FlexList>
          {pages.map(({ id, name, icon: Icon, dividerBefore }) => (
            <MainMenuItem
              key={id}
              dividerBefore={dividerBefore}
              icon={Icon}
              id={id}
              minimisedMenu={minimised}
              name={name}
              onClick={handleClick}
              selected={id === page?.id}
            />
          ))}

          {!floating && (
            <>
              <div style={{ flexGrow: 1 }} />

              <MainMenuItem
                icon={minimised ? ExpandMenuIcon : ContractMenuIcon}
                id="minimise"
                minimisedMenu={minimised}
                name="Collapse Menu"
                onClick={onMinimise}
                selected={false}
              />
            </>
          )}
        </FlexList>
      </DrawerContent>
    </StyledDrawer>
  )
}
const MemoMainMenu = memo(MainMenu)
export default MemoMainMenu

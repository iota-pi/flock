import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
import {
  Badge,
  Box,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
  Toolbar,
} from '@mui/material'
import { pages, usePage } from '../pages'
import { PageId } from '../pages/routes'
import { ContractMenuIcon, ExpandMenuIcon, MuiIconType } from '../Icons'
import { useNavigationStore } from '../../state/navigationStore'

export const DRAWER_SPACING_FULL = 30
export const DRAWER_SPACING_NARROW = 10

interface MinimisedProp {
  minimised: boolean,
  hasWarning?: boolean,
}
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
const StyledListItemButton = styled(
  ListItemButton,
  {
    shouldForwardProp: p => p !== 'minimised' && p !== 'hasWarning',
  },
)<MinimisedProp>(({ minimised, hasWarning, theme }) => ({
  flexGrow: 0,
  height: theme.spacing(minimised ? 8 : 6),
  justifyContent: 'center',
  transition: theme.transitions.create(['color', 'height']),
  ...(hasWarning
    ? {
      backgroundColor: theme.palette.warning.light,
      color: theme.palette.warning.contrastText,
      '&:hover': {
        backgroundColor: theme.palette.warning.main,
      },
      '&.Mui-selected': {
        backgroundColor: theme.palette.warning.main,
      },
    }
    : {}),
}))
const MenuItemIcon = styled(
  ListItemIcon,
  {
    shouldForwardProp: p => p !== 'minimised',
  },
)<MinimisedProp>(({ minimised, theme }) => ({
  color: 'inherit',
  minWidth: 0,
  paddingLeft: theme.spacing(minimised ? 1.5 : 0.5),
  paddingRight: theme.spacing(minimised ? 0 : 3),
  transition: theme.transitions.create('padding'),
}))
const MenuItemText = styled(
  ListItemText,
  {
    shouldForwardProp: p => p !== 'minimised',
  },
)<MinimisedProp>(({ minimised, theme }) => ({
  whiteSpace: 'nowrap',
  overflowX: 'hidden',
  textOverflow: 'ellipsis',
  transition: theme.transitions.create('opacity'),
  opacity: minimised ? 0 : undefined,

  '& .MuiListItemText-secondary': {
    display: 'inline',
  },
}))

interface Props {
  minimised?: boolean,
  onClick: () => void,
  onMinimise: () => void,
  open: boolean,
}

type MenuActionId = 'minimise'

interface MainMenuItemProps {
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: PageId | MenuActionId,
  minimisedMenu: boolean,
  name: string,
  onClick: (pageId?: PageId) => void,
  selected: boolean,
  warningCount?: number,
}


const MainMenuItem = memo(function MainMenuItem({
  dividerBefore,
  icon: Icon,
  id,
  minimisedMenu,
  name,
  onClick,
  selected,
  warningCount = 0,
}: MainMenuItemProps) {
  const handleClick = useCallback(
    () => (id !== 'minimise' ? onClick(id) : onClick()),
    [id, onClick],
  )

  return (
    <>
      {dividerBefore && (
        <Divider />
      )}

      <StyledListItemButton
        data-cy={`page-${id}`}
        hasWarning={warningCount > 0}
        minimised={minimisedMenu}
        onClick={handleClick}
        selected={selected}
      >
        <MenuItemIcon minimised={minimisedMenu}>
          {warningCount > 0
            ? (
              <Badge badgeContent={warningCount} color="error" max={99}>
                <Icon />
              </Badge>
            )
            : <Icon />}
        </MenuItemIcon>

        <MenuItemText
          minimised={minimisedMenu}
          primary={name}
        />
      </StyledListItemButton>
    </>
  )
})


function MainMenu({
  minimised = false,
  onClick,
  onMinimise,
  open,
}: Props) {
  const setSelected = useNavigationStore(state => state.setSelected)
  const navigate = useNavigate()
  const page = usePage()
  const previousPageIdRef = useRef<PageId | undefined>(page?.id)
  const currentPageIdRef = useRef<PageId | undefined>(page?.id)

  const pagePathById = useMemo(
    () => new Map<PageId, string>(pages.map(menuPage => [menuPage.id, menuPage.path])),
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
    (pageId?: PageId) => {
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
      variant="persistent"
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

          <Box sx={{
            flexGrow: 1
          }} />

          <MainMenuItem
            icon={minimised ? ExpandMenuIcon : ContractMenuIcon}
            id="minimise"
            minimisedMenu={minimised}
            name="Collapse Menu"
            onClick={onMinimise}
            selected={false}
          />
        </FlexList>
      </DrawerContent>
    </StyledDrawer>
  )
}
const MemoMainMenu = memo(MainMenu)
export default MemoMainMenu

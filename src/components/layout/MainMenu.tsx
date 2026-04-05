import { memo, ReactNode, useCallback, useMemo } from 'react'
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
import { useQuery } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { pages, usePage } from '../pages'
import { PageId } from '../pages/routes'
import { fetchMetadata } from '../../api/itemReadService'
import { trpc } from '../../api/trpc'
import { ContractMenuIcon, ExpandMenuIcon, MuiIconType } from '../Icons'
import { useLoggedIn } from 'src/state/selectors'
import { useUiStore } from '../../state/uiStore'

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

export interface Props {
  minimised?: boolean,
  onClick: () => void,
  onMinimise: () => void,
  open: boolean,
}

export interface UserInterface {
  id: string,
  name: string,
  icon: ReactNode,
}

type MenuActionId = 'minimise'

export interface MainMenuItemProps {
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: PageId | MenuActionId,
  minimisedMenu: boolean,
  name: string,
  onClick: (pageId?: PageId) => void,
  selected: boolean,
  warningCount?: number,
}


function MainMenuItem({
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
}


function MainMenu({
  minimised = false,
  onClick,
  onMinimise,
  open,
}: Props) {
  const setUi = useUiStore(state => state.setUi)
  const dlqCount = useUiStore(state => state.dlqCount)
  const navigate = useNavigate()
  const loggedIn = useLoggedIn()
  const { data: metadata = {} } = useQuery({
    queryKey: getQueryKey(trpc.accounts.getMetadata),
    queryFn: fetchMetadata,
    enabled: loggedIn,
  })
  const page = usePage()

  const handleClick = useCallback(
    (pageId?: PageId) => {
      if (pageId && page?.id !== pageId) {
        const newPage = pages.find(p => p.id === pageId)!
        navigate(newPage.path)
        setUi({ selected: [] })
      } else if (pageId === 'prayer' && page?.id === 'prayer') {
        navigate('/', {
          replace: true,
          state: {
            resetPrayerAt: Date.now(),
          },
        })
      }
      onClick()
    },
    [page?.id, navigate, onClick, setUi],
  )

  const pagesToShow = useMemo(
    () => pages.filter(p => (p.metadataControl ? p.metadataControl(metadata) : true)),
    [metadata],
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
          {pagesToShow.map(({ id, name, icon: Icon, dividerBefore }) => (
            <MainMenuItem
              key={id}
              dividerBefore={dividerBefore}
              icon={Icon}
              id={id}
              minimisedMenu={minimised}
              name={name}
              onClick={handleClick}
              selected={id === page?.id}
              warningCount={id === 'settings' ? dlqCount : 0}
            />
          ))}

          <Box flexGrow={1} />

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

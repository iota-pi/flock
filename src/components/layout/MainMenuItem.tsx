import { memo, useCallback } from 'react'
import {
  Badge,
  Divider,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  styled,
} from '@mui/material'
import type { MuiIconType } from '../Icons'
import type { ProtectedPageId } from '../pages/types'
import type { MinimisedProp } from './types'

interface MainMenuItemProps {
  dividerBefore?: boolean,
  icon: MuiIconType,
  id: ProtectedPageId | MenuActionId,
  minimisedMenu: boolean,
  name: string,
  onClick: (pageId?: ProtectedPageId) => void,
  selected: boolean,
  warningCount?: number,
}

type MenuActionId = 'minimise'

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


export const MainMenuItem = memo(function MainMenuItem({
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

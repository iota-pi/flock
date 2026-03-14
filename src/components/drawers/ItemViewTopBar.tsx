import { useState } from 'react'
import {
  Box,
  IconButton,
  Menu,
  Typography,
} from '@mui/material'
import { Item } from '../../state/items'
import {
  EditIcon,
  getIcon,
  MoreOptionsIcon,
} from '../Icons'

interface Props {
  item: Pick<Item, 'type' | 'name' | 'description'>,
  menuItems: React.ReactNode[],
  onEdit?: () => void,
  showEditButton?: boolean,
  compact?: boolean,
  editButtonDataCy?: string,
  menuButtonDataCy?: string,
}

function ItemViewTopBar({
  compact = false,
  editButtonDataCy = 'item-view-edit-button',
  item,
  menuButtonDataCy = 'item-view-menu-button',
  menuItems,
  onEdit,
  showEditButton = true,
}: Props) {
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null)
  const menuOpen = Boolean(menuAnchorEl)

  const actions = (
    <>
      {showEditButton && onEdit && (
        <IconButton
          data-cy={editButtonDataCy}
          onClick={onEdit}
          size="large"
        >
          <EditIcon />
        </IconButton>
      )}
      <IconButton
        data-cy={menuButtonDataCy}
        onClick={event => setMenuAnchorEl(event.currentTarget)}
        size="large"
      >
        <MoreOptionsIcon />
      </IconButton>
      <Menu
        anchorEl={menuAnchorEl}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        onClick={() => setMenuAnchorEl(null)}
        onClose={() => setMenuAnchorEl(null)}
        open={menuOpen}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {menuItems}
      </Menu>
    </>
  )

  if (compact) {
    return actions
  }

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: 'divider',
        px: 2,
        py: 1,
        display: 'flex',
        alignItems: 'center',
        minHeight: 56,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        {getIcon(item.type)}
      </Box>

      <Box sx={{ flexGrow: 1, mx: 1.5, minWidth: 0 }}>
        <Typography
          sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          variant="h6"
        >
          {item.name}
        </Typography>
        {item.description && (
          <Typography
            color="text.secondary"
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            variant="body2"
          >
            {item.description}
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        {actions}
      </Box>
    </Box>
  )
}

export default ItemViewTopBar

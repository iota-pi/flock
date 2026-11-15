import { memo, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import ListItemIcon from '@mui/material/ListItemIcon'
import Typography from '@mui/material/Typography'
import ListItemButton from '@mui/material/ListItemButton'

import type { MuiIconType } from './Icons'


interface SettingsItemProps {
  /** Shows the item in the error colour, for actions that destroy data */
  danger?: boolean,
  disabled?: boolean,
  icon?: MuiIconType,
  id: string,
  onClick?: () => void,
  title: string,
  value?: ReactNode,
}

function SettingsItem({
  danger,
  disabled,
  icon: Icon,
  id,
  onClick,
  title,
  value = null,
}: SettingsItemProps) {
  return (
    <ListItemButton
      disabled={disabled || !onClick}
      data-cy={id}
      onClick={onClick}
    >
      {Icon && (
        <ListItemIcon>
          <Icon color={danger ? 'error' : undefined} fontSize="small" />
        </ListItemIcon>
      )}
      <Box sx={{
        flexGrow: 1
      }}>
        <Box sx={{
          py: 1
        }}>
          <Typography color={danger ? 'error' : undefined}>
            {title}
          </Typography>
        </Box>
      </Box>
      <Box
        sx={{
          display: "flex",
          alignItems: "center"
        }}>
        {value}
      </Box>
    </ListItemButton>
  )
}

export default memo(SettingsItem)

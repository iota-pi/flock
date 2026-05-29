import { memo, ReactNode } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import ListItemButton from '@mui/material/ListItemButton'

import type { MuiIconType } from './Icons'


interface SettingsItemProps {
  disabled?: boolean,
  icon?: MuiIconType,
  id: string,
  onClick?: () => void,
  title: string,
  value?: ReactNode,
}

function SettingsItem({
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
      <Box sx={{
        flexGrow: 1
      }}>
        <Box sx={{
          py: 1
        }}>
          <Typography>
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

        {Icon && (
          <IconButton
            data-cy="edit-button"
            disableRipple
            size="medium"
            aria-label={`edit-${id}`}
          >
            <Icon fontSize="small" />
          </IconButton>
        )}
      </Box>
    </ListItemButton>
  )
}

export default memo(SettingsItem)

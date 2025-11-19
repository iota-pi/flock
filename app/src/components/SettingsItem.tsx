import React from 'react'
import { Box, Divider, IconButton, ListItemButton, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import type { MuiIconType } from './Icons'

export interface SettingsItemProps {
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
    <>
      <ListItemButton
        disabled={disabled || !onClick}
        data-cy={id}
        onClick={onClick}
      >
        <Box flexGrow={1}>
          <Box py={1}>
            <Typography>
              {title}
            </Typography>
          </Box>
        </Box>

        <Box display="flex" alignItems="center">
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

      <Divider />
    </>
  )
}

export default React.memo(SettingsItem)

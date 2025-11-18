import React from 'react'
import { Box, Divider, IconButton, ListItem, styled, Typography } from '@mui/material'
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

const LeftCheckboxLabel = styled('div')(() => ({}))

function SettingsItem({
  disabled,
  icon: Icon,
  id,
  onClick,
  title,
  value = null,
}: SettingsItemProps) {
  const extraListItemProps: object = React.useMemo(() => ({ button: !!onClick }), [onClick])

  return (
    <>
      <ListItem
        {...extraListItemProps}
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
      </ListItem>

      <Divider />
    </>
  )
}

export default React.memo(SettingsItem)

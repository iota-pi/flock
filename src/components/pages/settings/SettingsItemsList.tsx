import { ReactNode } from 'react'
import Divider from '@mui/material/Divider'
import { styled } from '@mui/material/styles'
import Typography from '@mui/material/Typography'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import List from '@mui/material/List'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'

import SettingsItem from '../../SettingsItem'
import { SettingsActionId, settingsConfig, SettingsValueRenderer } from './settingsConfig'

type SettingsValues = {
  darkMode: boolean | null
  goal: number
  naturalGoal: number
  recoveryItemsExist: boolean
  biometricsEnabled: boolean
  biometricsSupported: boolean
}

type SettingsItemsListProps = {
  actionHandlers: Record<SettingsActionId, () => void>
  values: SettingsValues
}

const LeftControlLabel = styled(FormControlLabel)(({ theme }) => ({
  marginRight: 0,

  '& .MuiCheckbox-root, & .MuiSwitch-root': {
    marginLeft: theme.spacing(1),
  },
}))

function getDarkModeLabel(darkMode: boolean | null): string {
  if (darkMode === null) {
    return 'System default'
  }

  return darkMode ? 'Always dark mode' : 'Always light mode'
}

function renderValue(renderer: SettingsValueRenderer | undefined, values: SettingsValues): ReactNode {
  if (!renderer || renderer === 'none') {
    return undefined
  }

  if (renderer === 'darkModeToggle') {
    return (
      <LeftControlLabel
        control={(
          <Checkbox
            checked={values.darkMode || false}
            indeterminate={values.darkMode === null}
            size="small"
          />
        )}
        label={getDarkModeLabel(values.darkMode)}
        labelPlacement="start"
      />
    )
  }

  if (renderer === 'biometricsToggle') {
    return (
      <LeftControlLabel
        control={(
          <Switch
            checked={values.biometricsEnabled}
            size="small"
            color="primary"
          />
        )}
        label={values.biometricsEnabled ? 'Enabled' : 'Disabled'}
        labelPlacement="start"
      />
    )
  }

  if (renderer === 'goalValue') {
    return (
      <Typography
        color={values.goal < values.naturalGoal ? 'secondary' : 'textPrimary'}
        sx={{ mr: 2, fontWeight: 500 }}
      >
        {values.goal}
      </Typography>
    )
  }

  return undefined
}

export default function SettingsItemsList({ actionHandlers, values }: SettingsItemsListProps) {
  return (
    <List disablePadding>
      {settingsConfig.map(item => {
        if (item.type === 'divider') {
          return <Divider key={item.key} />
        }

        const isBiometricsUnsupported = item.disabledWhen === 'biometricsUnsupported' && !values.biometricsSupported
        const isNoRecoveryItems = item.disabledWhen === 'noRecoveryItems' && !values.recoveryItemsExist
        
        const disabled = isBiometricsUnsupported || isNoRecoveryItems

        const itemProps = {
          id: item.id,
          title: item.title,
          icon: item.icon,
          onClick: actionHandlers[item.action],
          value: renderValue(item.valueRenderer, values),
          disabled,
        }

        if (isBiometricsUnsupported) {
          return (
            <Tooltip key={item.id} title="Biometrics are not supported on this device" placement="left">
              <span>
                <SettingsItem {...itemProps} />
              </span>
            </Tooltip>
          )
        }

        if (isNoRecoveryItems) {
          return (
            <Tooltip key={item.id} title="No items require recovery" placement="left">
              <span>
                <SettingsItem {...itemProps} />
              </span>
            </Tooltip>
          )
        }

        return <SettingsItem key={item.id} {...itemProps} />
      })}
    </List>
  )
}
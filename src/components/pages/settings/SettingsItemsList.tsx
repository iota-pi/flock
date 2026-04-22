import { ReactNode } from 'react'
import {
  Checkbox,
  Divider,
  FormControlLabel,
  List,
  styled,
  Typography,
} from '@mui/material'
import SettingsItem from '../../SettingsItem'
import { SettingsActionId, settingsConfig, SettingsValueRenderer } from './settingsConfig'

type SettingsValues = {
  darkMode: boolean | null
  goal: number
  naturalGoal: number
  itemCacheExists: boolean
  recoveryItemsExist: boolean
}

type SettingsItemsListProps = {
  actionHandlers: Record<SettingsActionId, () => void>
  values: SettingsValues
}

const LeftCheckboxLabel = styled(FormControlLabel)(({ theme }) => ({
  marginRight: 0,

  '& .MuiCheckbox-root': {
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
      <LeftCheckboxLabel
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

  if (renderer === 'goalValue') {
    return (
      <Typography
        color={values.goal < values.naturalGoal ? 'secondary' : 'textPrimary'}
        fontWeight={500}
        sx={{ mr: 2 }}
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

        const disabled = (
          (item.disabledWhen === 'noItemCache' && !values.itemCacheExists)
          || (item.disabledWhen === 'noRecoveryItems' && !values.recoveryItemsExist)
        )

        return (
          <SettingsItem
            key={item.id}
            id={item.id}
            title={item.title}
            icon={item.icon}
            onClick={actionHandlers[item.action]}
            value={renderValue(item.valueRenderer, values)}
            disabled={disabled}
          />
        )
      })}
    </List>
  )
}
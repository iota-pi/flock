import {
  DeleteIcon,
  DownloadIcon,
  FrequencyIcon,
  EditIcon,
  MuiIconType,
  NotificationIcon,
  PersonIcon,
  RestoreIcon,
  SignOutIcon,
  UploadIcon,
  PasswordIcon,
} from '../../Icons'

export type SettingsActionId =
  | 'signOut'
  | 'clearCache'
  | 'toggleDarkMode'
  | 'openGoalDialog'
  | 'openDefaultFrequencyDialog'
  | 'openSubscriptionDialog'
  | 'exportData'
  | 'openRestoreDialog'
  | 'openRecoveryDialog'
  | 'openImportDialog'
  | 'openChangePasswordDialog'

export type SettingsValueRenderer = 'none' | 'darkModeToggle' | 'goalValue'

type SettingsItemConfig = {
  type: 'item'
  id: string
  title: string
  icon?: MuiIconType
  action: SettingsActionId
  valueRenderer?: SettingsValueRenderer
  disabledWhen?: 'noItemCache' | 'noRecoveryItems'
}

type SettingsDividerConfig = {
  type: 'divider'
  key: string
}

type SettingsConfigEntry = SettingsItemConfig | SettingsDividerConfig

export const settingsConfig: SettingsConfigEntry[] = [
  {
    type: 'item',
    id: 'logout',
    title: 'Sign out',
    icon: SignOutIcon,
    action: 'signOut',
  },
  { type: 'divider', key: 'd1' },
  {
    type: 'item',
    id: 'clear-cache',
    title: 'Clear item cache',
    icon: DeleteIcon,
    action: 'clearCache',
    disabledWhen: 'noItemCache',
  },
  { type: 'divider', key: 'd2' },
  {
    type: 'item',
    id: 'change-password',
    title: 'Change password',
    icon: PasswordIcon,
    action: 'openChangePasswordDialog',
  },
  { type: 'divider', key: 'd-pw' },
  {
    type: 'item',
    id: 'darkmode',
    title: 'Use dark mode',
    action: 'toggleDarkMode',
    valueRenderer: 'darkModeToggle',
  },
  { type: 'divider', key: 'd3' },
  {
    type: 'item',
    id: 'prayer-goal',
    title: 'Daily prayer goal',
    icon: EditIcon,
    action: 'openGoalDialog',
    valueRenderer: 'goalValue',
  },
  {
    type: 'item',
    id: 'default-frequency',
    title: 'Set default prayer frequency for new items',
    icon: FrequencyIcon,
    action: 'openDefaultFrequencyDialog',
  },
  { type: 'divider', key: 'd4' },
  {
    type: 'item',
    id: 'reminders',
    title: 'Prayer reminder notifications',
    icon: NotificationIcon,
    action: 'openSubscriptionDialog',
  },
  { type: 'divider', key: 'd5' },
  {
    type: 'item',
    id: 'export',
    title: 'Create a backup of your data',
    icon: DownloadIcon,
    action: 'exportData',
  },
  {
    type: 'item',
    id: 'restore',
    title: 'Restore from a backup',
    icon: UploadIcon,
    action: 'openRestoreDialog',
  },
  {
    type: 'item',
    id: 'data-recovery',
    title: 'Corrupted data recovery',
    icon: RestoreIcon,
    action: 'openRecoveryDialog',
    disabledWhen: 'noRecoveryItems',
  },
  {
    type: 'item',
    id: 'import-people',
    title: 'Import from CSV',
    icon: PersonIcon,
    action: 'openImportDialog',
  },
  { type: 'divider', key: 'd6' },
]
import {
  DownloadIcon,
  FrequencyIcon,
  LockIcon,
  MuiIconType,
  NotificationIcon,
  PersonIcon,
  RestoreIcon,
  SignOutIcon,
  UploadIcon,
  PasswordIcon,
  FingerprintIcon,
  PrayerIcon,
} from '../../Icons'

export type SettingsActionId =
  | 'lock'
  | 'removeAccount'
  | 'toggleDarkMode'
  | 'toggleBiometrics'
  | 'openAutoLockDialog'
  | 'openGoalDialog'
  | 'openDefaultFrequencyDialog'
  | 'openSubscriptionDialog'
  | 'exportData'
  | 'openRestoreDialog'
  | 'openRecoveryDialog'
  | 'openImportDialog'
  | 'openChangePasswordDialog'

export type SettingsValueRenderer = 'none' | 'darkModeToggle' | 'goalValue' | 'biometricsToggle' | 'autoLockValue'

type SettingsItemConfig = {
  type: 'item'
  id: string
  title: string
  icon?: MuiIconType
  action: SettingsActionId
  valueRenderer?: SettingsValueRenderer
  disabledWhen?: 'noRecoveryItems' | 'biometricsUnsupported'
}

type SettingsDividerConfig = {
  type: 'divider'
  key: string
}

type SettingsConfigEntry = SettingsItemConfig | SettingsDividerConfig

export const settingsConfig: SettingsConfigEntry[] = [
  {
    type: 'item',
    id: 'lock',
    title: 'Lock',
    icon: LockIcon,
    action: 'lock',
  },
  {
    type: 'item',
    id: 'logout',
    title: 'Sign out & remove local data',
    icon: SignOutIcon,
    action: 'removeAccount',
  },
  { type: 'divider', key: 'd1' },
  {
    type: 'item',
    id: 'change-password',
    title: 'Change password',
    icon: PasswordIcon,
    action: 'openChangePasswordDialog',
  },
  {
    type: 'item',
    id: 'biometrics',
    title: 'Unlock with biometrics',
    icon: FingerprintIcon,
    action: 'toggleBiometrics',
    valueRenderer: 'biometricsToggle',
    disabledWhen: 'biometricsUnsupported',
  },
  {
    type: 'item',
    id: 'auto-lock',
    title: 'Auto-lock',
    icon: LockIcon,
    action: 'openAutoLockDialog',
    valueRenderer: 'autoLockValue',
  },
  { type: 'divider', key: 'd-pw' },
  {
    type: 'item',
    id: 'darkmode',
    title: 'Use dark mode',
    action: 'toggleDarkMode',
    valueRenderer: 'darkModeToggle',
  },
  { type: 'divider', key: 'd2' },
  {
    type: 'item',
    id: 'prayer-goal',
    title: 'Daily prayer goal',
    icon: PrayerIcon,
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
  { type: 'divider', key: 'd3' },
  {
    type: 'item',
    id: 'reminders',
    title: 'Prayer reminder notifications',
    icon: NotificationIcon,
    action: 'openSubscriptionDialog',
  },
  { type: 'divider', key: 'd4' },
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
  { type: 'divider', key: 'd5' },
]
import { ReactNode, Suspense, lazy, useCallback, useMemo, useState } from 'react'
import {
  Checkbox,
  Divider,
  FormControlLabel,
  List,
  styled,
  Typography,
} from '@mui/material'
import download from 'js-file-download'
import BasePage from './BasePage'
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
} from '../Icons'
import SettingsItem from '../SettingsItem'
import useSettings from '../../hooks/useSettings'
import { useUiStore } from '../../state/uiStore'
import { processOfflineQueue } from '../../api/offlineQueue'

const GoalDialog = lazy(() => import('../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../dialogs/RestoreBackupDialog'))
const OfflineRecoveryDialog = lazy(() => import('../dialogs/OfflineRecoveryDialog'))
const ImportPeopleDialog = lazy(() => import('../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../dialogs/DefaultFrequencyDialog'))
const ConfirmationDialog = lazy(() => import('../dialogs/ConfirmationDialog'))
import PageContainer from '../PageContainer'

const LeftCheckboxLabel = styled(FormControlLabel)(({ theme }) => ({
  marginRight: 0,

  '& .MuiCheckbox-root': {
    marginLeft: theme.spacing(1),
  },
}))

type SettingsItemConfig = {
  type: 'item',
  id: string,
  title: string,
  icon?: MuiIconType,
  onClick?: () => void,
  value?: ReactNode,
  disabled?: boolean,
} | {
  type: 'divider',
  key: string,
}

function SettingsPage() {
  const { actions, dialogs, values } = useSettings()
  const dlqCount = useUiStore(state => state.dlqCount)
  const [showExportWarning, setShowExportWarning] = useState(false)

  const executeExport = useCallback(
    async () => {
      try {
        const json = await actions.handleExport()
        download(json, 'flock.backup.json')
      } catch (err) {
        console.error('Export failed', err)
      } finally {
        setShowExportWarning(false)
      }
    },
    [actions],
  )

  const onExportClick = useCallback(
    async () => {
      await processOfflineQueue()

      const offlineQueueLength = useUiStore.getState().offlineQueueLength
      const queuedRecoveryCount = useUiStore.getState().dlqCount

      if (offlineQueueLength > 0 || queuedRecoveryCount > 0) {
        setShowExportWarning(true)
        return
      }

      await executeExport()
    },
    [executeExport],
  )

  const darkOrLightLabel = values.darkMode ? 'Always dark mode' : 'Always light mode'
  const darkModeLabel = values.darkMode === null ? 'System default' : darkOrLightLabel

  const settingsList: SettingsItemConfig[] = useMemo(() => [
    {
      type: 'item',
      id: 'logout',
      title: 'Sign out',
      icon: SignOutIcon,
      onClick: actions.handleSignOut,
    },
    { type: 'divider', key: 'd1' },
    {
      type: 'item',
      id: 'clear-cache',
      title: 'Clear item cache',
      icon: DeleteIcon,
      onClick: actions.handleClearCache,
      disabled: !values.itemCacheExists,
    },
    { type: 'divider', key: 'd2' },
    {
      type: 'item',
      id: 'darkmode',
      title: 'Use dark mode',
      onClick: actions.handleToggleDarkMode,
      value: (
        <LeftCheckboxLabel
          control={(
            <Checkbox
              checked={values.darkMode || false}
              indeterminate={values.darkMode === null}
              size="small"
            />
          )}
          label={darkModeLabel}
          labelPlacement="start"
        />
      ),
    },
    { type: 'divider', key: 'd3' },
    {
      type: 'item',
      id: 'prayer-goal',
      title: 'Daily prayer goal',
      icon: EditIcon,
      onClick: () => dialogs.open('goal'),
      value: (
        <Typography
          color={values.goal < values.naturalGoal ? 'secondary' : 'textPrimary'}
          fontWeight={500}
          sx={{ mr: 2 }}
        >
          {values.goal}
        </Typography>
      ),
    },
    {
      type: 'item',
      id: 'default-frequency',
      title: 'Set default prayer frequency for new items',
      icon: FrequencyIcon,
      onClick: () => dialogs.open('defaultFrequency'),
    },
    { type: 'divider', key: 'd4' },
    {
      type: 'item',
      id: 'reminders',
      title: 'Prayer reminder notifications',
      icon: NotificationIcon,
      onClick: () => dialogs.open('subscription'),
    },
    { type: 'divider', key: 'd5' },
    {
      type: 'item',
      id: 'export',
      title: 'Create a backup of your data',
      icon: DownloadIcon,
      onClick: onExportClick,
    },
    {
      type: 'item',
      id: 'restore',
      title: 'Restore from a backup',
      icon: UploadIcon,
      onClick: () => dialogs.open('restore'),
    },
    {
      type: 'item',
      id: 'offline-recovery',
      title: 'Offline data recovery',
      icon: RestoreIcon,
      onClick: () => dialogs.open('offlineRecovery'),
      disabled: dlqCount === 0,
      value: dlqCount > 0
        ? (
          <Typography color="warning.main" fontWeight={500} sx={{ mr: 2 }}>
            {dlqCount}
          </Typography>
        )
        : undefined,
    },
    {
      type: 'item',
      id: 'import-people',
      title: 'Import from CSV',
      icon: PersonIcon,
      onClick: () => dialogs.open('import'),
    },
    { type: 'divider', key: 'd6' },
  ], [actions, dialogs, darkModeLabel, dlqCount, onExportClick, values])

  return (
    <BasePage>
      <PageContainer maxWidth="xl">
        <Typography variant="h4" fontWeight={300} gutterBottom>
          Settings
        </Typography>

        <Typography color="textSecondary">
          Account ID: {values.account}
        </Typography>
      </PageContainer>

      <Divider />

      <List disablePadding>
        {settingsList.map(item => {
          if (item.type === 'divider') {
            return <Divider key={item.key} />
          }
          return (
            <SettingsItem
              key={item.id}
              id={item.id}
              title={item.title}
              icon={item.icon}
              onClick={item.onClick}
              value={item.value}
              disabled={item.disabled}
            />
          )
        })}
      </List>

      <Suspense fallback={null}>
        <GoalDialog
          naturalGoal={values.naturalGoal}
          onClose={dialogs.close}
          open={dialogs.active === 'goal'}
        />
        <RestoreBackupDialog
          onClose={dialogs.close}
          onConfirm={actions.handleConfirmRestore}
          open={dialogs.active === 'restore'}
        />
        <OfflineRecoveryDialog
          onClose={dialogs.close}
          open={dialogs.active === 'offlineRecovery'}
        />
        <ImportPeopleDialog
          onClose={dialogs.close}
          onConfirm={actions.handleConfirmImport}
          open={dialogs.active === 'import'}
        />
        <SubscriptionDialog
          onClose={dialogs.close}
          onSave={actions.handleSubscribe}
          open={dialogs.active === 'subscription'}
        />
        <DefaultFrequencyDialog
          open={dialogs.active === 'defaultFrequency'}
          defaults={values.defaultFrequencies}
          onClose={dialogs.close}
          onSave={actions.saveDefaultFrequencies}
        />
        <ConfirmationDialog
          open={showExportWarning}
          title="Unsynced Offline Changes"
          confirm="Export Anyway"
          onConfirm={executeExport}
          onCancel={() => setShowExportWarning(false)}
        >
          You have offline edits or recovery items that have not been saved to the cloud. Creating a backup now will include these local changes. Are you sure you want to proceed?
        </ConfirmationDialog>
      </Suspense>
    </BasePage>
  )
}

export default SettingsPage

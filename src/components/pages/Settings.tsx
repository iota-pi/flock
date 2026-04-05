import { ReactNode, Suspense, lazy, useCallback, useMemo } from 'react'
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
import { useSyncStore } from '../../state/syncStore'
import { processOfflineQueue } from '../../sync/offlineQueue'
import { useDialogState } from '../../hooks/useDialogState'

const GoalDialog = lazy(() => import('../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../dialogs/RestoreBackupDialog'))
const OfflineRecoveryDialog = lazy(() => import('../dialogs/OfflineRecoveryDialog'))
const ImportPeopleDialog = lazy(() => import('../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../dialogs/DefaultFrequencyDialog'))
import PageContainer from '../ui/PageContainer'

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
  const { actions, values } = useSettings()
  const dlqCount = useSyncStore(state => state.dlqCount)
  const goalDialog = useDialogState('goal')
  const restoreDialog = useDialogState('restore')
  const offlineRecoveryDialog = useDialogState('offlineRecovery')
  const importDialog = useDialogState('import')
  const subscriptionDialog = useDialogState('subscription')
  const defaultFrequencyDialog = useDialogState('defaultFrequency')

  const onExport = useCallback(
    async () => {
      try {
        await processOfflineQueue()
        const json = await actions.handleExport()
        download(json, 'flock.backup.json')
      } catch (err) {
        console.error('Export failed', err)
      }
    },
    [actions],
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
      onClick: goalDialog.openDialog,
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
      onClick: defaultFrequencyDialog.openDialog,
    },
    { type: 'divider', key: 'd4' },
    {
      type: 'item',
      id: 'reminders',
      title: 'Prayer reminder notifications',
      icon: NotificationIcon,
      onClick: subscriptionDialog.openDialog,
    },
    { type: 'divider', key: 'd5' },
    {
      type: 'item',
      id: 'export',
      title: 'Create a backup of your data',
      icon: DownloadIcon,
      onClick: onExport,
    },
    {
      type: 'item',
      id: 'restore',
      title: 'Restore from a backup',
      icon: UploadIcon,
      onClick: restoreDialog.openDialog,
    },
    {
      type: 'item',
      id: 'offline-recovery',
      title: 'Offline data recovery',
      icon: RestoreIcon,
      onClick: offlineRecoveryDialog.openDialog,
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
      onClick: importDialog.openDialog,
    },
    { type: 'divider', key: 'd6' },
  ], [
    actions,
    darkModeLabel,
    defaultFrequencyDialog.openDialog,
    dlqCount,
    goalDialog.openDialog,
    importDialog.openDialog,
    offlineRecoveryDialog.openDialog,
    onExport,
    restoreDialog.openDialog,
    subscriptionDialog.openDialog,
    values,
  ])

  const handleRestoreConfirm = useCallback(async (payload: Parameters<typeof actions.handleConfirmRestore>[0]) => {
    const saved = await actions.handleConfirmRestore(payload)
    if (saved) {
      restoreDialog.closeDialog()
    }
  }, [actions, restoreDialog])

  const handleImportConfirm = useCallback(async (items: Parameters<typeof actions.handleConfirmImport>[0]) => {
    const saved = await actions.handleConfirmImport(items)
    if (saved) {
      importDialog.closeDialog()
    }
  }, [actions, importDialog])

  const handleSubscriptionSave = useCallback(async (hours: Parameters<typeof actions.handleSubscribe>[0]) => {
    const saved = await actions.handleSubscribe(hours)
    if (saved) {
      subscriptionDialog.closeDialog()
    }
  }, [actions, subscriptionDialog])

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
          onClose={goalDialog.closeDialog}
          open={goalDialog.isOpen}
        />
        <RestoreBackupDialog
          onClose={restoreDialog.closeDialog}
          onConfirm={handleRestoreConfirm}
          open={restoreDialog.isOpen}
        />
        <OfflineRecoveryDialog
          onClose={offlineRecoveryDialog.closeDialog}
          open={offlineRecoveryDialog.isOpen}
        />
        <ImportPeopleDialog
          onClose={importDialog.closeDialog}
          onConfirm={handleImportConfirm}
          open={importDialog.isOpen}
        />
        <SubscriptionDialog
          onClose={subscriptionDialog.closeDialog}
          onSave={handleSubscriptionSave}
          open={subscriptionDialog.isOpen}
        />
        <DefaultFrequencyDialog
          open={defaultFrequencyDialog.isOpen}
          defaults={values.defaultFrequencies}
          onClose={defaultFrequencyDialog.closeDialog}
          onSave={actions.saveDefaultFrequencies}
        />
      </Suspense>
    </BasePage>
  )
}

export default SettingsPage

import { ReactNode, Suspense, lazy, useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  List,
  Paper,
  Stack,
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
  SignOutIcon,
  UploadIcon,
} from '../Icons'
import SettingsItem from '../SettingsItem'
import useSettings from '../../hooks/useSettings'
import {
  type QueuedMutation,
  readDeadLetterQueue,
  readQueue,
  writeDeadLetterQueue,
  writeQueue,
} from '../../api/offlineQueueStore'
import { processOfflineQueue } from '../../api/offlineQueue'
import { useUiStore } from '../../state/uiStore'

const GoalDialog = lazy(() => import('../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../dialogs/RestoreBackupDialog'))
const ImportPeopleDialog = lazy(() => import('../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../dialogs/DefaultFrequencyDialog'))
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
  const setDlqCount = useUiStore(state => state.setDlqCount)

  const fetchDeadLetterItems = useCallback(async (): Promise<QueuedMutation[]> => {
    const items = await readDeadLetterQueue()
    setDlqCount(items.length)
    return items
  }, [setDlqCount])

  const {
    data: deadLetterItems = [],
    refetch: refetchDeadLetterItems,
  } = useQuery({
    queryKey: ['deadLetterQueue'],
    queryFn: fetchDeadLetterItems,
  })

  const handleRetryDeadLetterMutation = useCallback(async (id: string) => {
    const dlqItems = await readDeadLetterQueue()
    const mutation = dlqItems.find(item => item.id === id)
    if (!mutation) {
      await refetchDeadLetterItems()
      return
    }

    const nextDlqItems = dlqItems.filter(item => item.id !== id)
    const queueItems = await readQueue()
    queueItems.push(mutation)

    await writeQueue(queueItems)
    await writeDeadLetterQueue(nextDlqItems)
    setDlqCount(nextDlqItems.length)

    await processOfflineQueue()
    await refetchDeadLetterItems()
  }, [refetchDeadLetterItems, setDlqCount])

  const handleDiscardDeadLetterMutation = useCallback(async (id: string) => {
    const dlqItems = await readDeadLetterQueue()
    const nextDlqItems = dlqItems.filter(item => item.id !== id)
    await writeDeadLetterQueue(nextDlqItems)
    setDlqCount(nextDlqItems.length)
    await refetchDeadLetterItems()
  }, [refetchDeadLetterItems, setDlqCount])

  const onExport = useCallback(
    async () => {
      try {
        const json = await actions.handleExport()
        return download(json, 'flock.backup.json')
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
      onClick: onExport,
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
      id: 'import-people',
      title: 'Import from CSV',
      icon: PersonIcon,
      onClick: () => dialogs.open('import'),
    },
    { type: 'divider', key: 'd6' },
  ], [actions, dialogs, darkModeLabel, onExport, values])

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

      {deadLetterItems.length > 0 && (
        <PageContainer maxWidth="xl">
          <Stack spacing={2} py={2}>
            <Typography variant="h5" fontWeight={400}>
              Offline Data Recovery
            </Typography>

            {deadLetterItems.map(item => (
              <Paper key={item.id} variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                  <Stack flexGrow={1} spacing={0.5}>
                    <Typography variant="subtitle1" fontWeight={500}>
                      {item.mutationType}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Last error status: {item.lastErrorStatus ?? 'Unknown'}
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      Last conflict at: {item.lastConflictAt ? new Date(item.lastConflictAt).toLocaleString() : 'N/A'}
                    </Typography>
                  </Stack>

                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={() => {
                        void handleRetryDeadLetterMutation(item.id)
                      }}
                    >
                      Retry
                    </Button>
                    <Button
                      variant="outlined"
                      color="warning"
                      size="small"
                      onClick={() => {
                        void handleDiscardDeadLetterMutation(item.id)
                      }}
                    >
                      Discard
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </PageContainer>
      )}

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
      </Suspense>
    </BasePage>
  )
}

export default SettingsPage

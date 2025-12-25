import { ReactNode, Suspense, lazy, useCallback } from 'react'
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
  SignOutIcon,
  UploadIcon,
} from '../Icons'
import SettingsItem from '../SettingsItem'
import useSettings from '../../hooks/useSettings'
const GoalDialog = lazy(() => import('../dialogs/GoalDialog'))
const RestoreBackupDialog = lazy(() => import('../dialogs/RestoreBackupDialog'))
const ImportPeopleDialog = lazy(() => import('../dialogs/ImportPeopleDialog'))
const SubscriptionDialog = lazy(() => import('../dialogs/SubscriptionDialog'))
const DefaultFrequencyDialog = lazy(() => import('../dialogs/DefaultFrequencyDialog'))
import PageContainer from '../PageContainer'

export interface SettingsItemProps {
  disabled?: boolean,
  icon?: MuiIconType,
  id: string,
  onClick?: () => void,
  title: string,
  value?: ReactNode,
}

const LeftCheckboxLabel = styled(FormControlLabel)(({ theme }) => ({
  marginRight: 0,

  '& .MuiCheckbox-root': {
    marginLeft: theme.spacing(1),
  },
}))
function SettingsPage() {
  const {
    account,
    darkMode,
    handleSignOut,
    handleToggleDarkMode,
    naturalGoal,
    goal,
    itemCacheExists,
    handleClearCache,
    handleExport,
    showGoalDialog,
    openGoalDialog,
    closeGoalDialog,
    showSubscriptionDialog,
    openSubscriptionDialog,
    closeSubscriptionDialog,
    showRestoreDialog,
    openRestoreDialog,
    closeRestoreDialog,
    showImportDialog,
    openImportDialog,
    closeImportDialog,
    handleConfirmRestore,
    handleConfirmImport,
    handleSubscribe,
    showDefaultFrequencyDialog,
    openDefaultFrequencyDialog,
    closeDefaultFrequencyDialog,
    defaultFrequencies,
    saveDefaultFrequencies,
  } = useSettings()

  const handleEditGoal = openGoalDialog
  const handleCloseGoalDialog = closeGoalDialog
  const handleEditSubscription = openSubscriptionDialog
  const handleRestore = openRestoreDialog
  const handleImport = openImportDialog
  const handleCloseSubscriptionDialog = closeSubscriptionDialog
  const handleCloseRestoreDialog = closeRestoreDialog
  const handleCloseImportDialog = closeImportDialog

  const darkOrLightLabel = darkMode ? 'Always dark mode' : 'Always light mode'
  const darkModeLabel = darkMode === null ? 'System default' : darkOrLightLabel

  const onExport = useCallback(
    async () => {
      try {
        const json = await handleExport()
        return download(json, 'flock.backup.json')
      } catch (err) {
        console.error('Export failed', err)
      }
    },
    [handleExport],
  )

  return (
    <BasePage>
      <PageContainer maxWidth="xl">
        <Typography variant="h4" fontWeight={300} gutterBottom>
          Settings
        </Typography>

        <Typography color="textSecondary">
          Account ID: {account}
        </Typography>
      </PageContainer>

      <Divider />

      <List disablePadding>
        <SettingsItem
          icon={SignOutIcon}
          id="logout"
          onClick={handleSignOut}
          title="Sign out"
        />
        <Divider />
        <SettingsItem
          disabled={!itemCacheExists}
          icon={DeleteIcon}
          id="clear-cache"
          onClick={handleClearCache}
          title="Clear item cache"
        />
        <Divider />
        <SettingsItem
          id="darkmode"
          onClick={handleToggleDarkMode}
          title="Use dark mode"
          value={(
            <LeftCheckboxLabel
              control={(
                <Checkbox
                  checked={darkMode || false}
                  indeterminate={darkMode === null}
                  size="small"
                />
              )}
              label={darkModeLabel}
              labelPlacement="start"
            />
          )}
        />
        <Divider />
        <SettingsItem
          icon={EditIcon}
          id="prayer-goal"
          onClick={handleEditGoal}
          title="Daily prayer goal"
          value={(
            <Typography
              color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
              fontWeight={500}
              sx={{ mr: 2 }}
            >
              {goal}
            </Typography>
          )}
        />
        <SettingsItem
          icon={FrequencyIcon}
          id="default-frequency"
          onClick={openDefaultFrequencyDialog}
          title="Set default prayer frequency for new items"
        />
        <Divider />
        <SettingsItem
          icon={NotificationIcon}
          id="reminders"
          onClick={handleEditSubscription}
          title="Prayer reminder notifications (temporarily unavailable)"
          disabled
        />
        <Divider />
        <SettingsItem
          icon={DownloadIcon}
          id="export"
          onClick={onExport}
          title="Create a backup of your data"
        />
        <SettingsItem
          icon={UploadIcon}
          id="restore"
          onClick={handleRestore}
          title="Restore from a backup"
        />
        <SettingsItem
          icon={PersonIcon}
          id="import-people"
          onClick={handleImport}
          title="Import from CSV"
        />
        <Divider />
      </List>

      <Suspense fallback={null}>
        <GoalDialog
          naturalGoal={naturalGoal}
          onClose={handleCloseGoalDialog}
          open={showGoalDialog}
        />
        <RestoreBackupDialog
          onClose={handleCloseRestoreDialog}
          onConfirm={handleConfirmRestore}
          open={showRestoreDialog}
        />
        <ImportPeopleDialog
          onClose={handleCloseImportDialog}
          onConfirm={handleConfirmImport}
          open={showImportDialog}
        />
        <SubscriptionDialog
          onClose={handleCloseSubscriptionDialog}
          onSave={handleSubscribe}
          open={showSubscriptionDialog}
        />
        <DefaultFrequencyDialog
          open={showDefaultFrequencyDialog}
          defaults={defaultFrequencies}
          onClose={closeDefaultFrequencyDialog}
          onSave={saveDefaultFrequencies}
        />
      </Suspense>
    </BasePage>
  )
}

export default SettingsPage

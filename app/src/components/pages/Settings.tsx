import { ReactNode, useCallback, useState } from 'react'
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
  EditIcon,
  MuiIconType,
  NotificationIcon,
  PersonIcon,
  SignOutIcon,
  UploadIcon,
} from '../Icons'
import SettingsItem from '../SettingsItem'
import useSettings from '../../hooks/useSettings'
import GoalDialog from '../dialogs/GoalDialog'
import RestoreBackupDialog from '../dialogs/RestoreBackupDialog'
import { subscribe, unsubscribe } from '../../utils/firebase'
import SubscriptionDialog from '../dialogs/SubscriptionDialog'
import ImportPeopleDialog from '../dialogs/ImportPeopleDialog'
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
    handleConfirmRestore,
    handleConfirmImport,
  } = useSettings()

  const [showGoalDialog, setShowGoalDialog] = useState(false)
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])

  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false)
  const handleEditSubscription = useCallback(() => setShowSubscriptionDialog(true), [])
  const handleCloseSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(false), [])

  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  const handleRestore = useCallback(() => setShowRestoreDialog(true), [])
  const handleCloseRestoreDialog = useCallback(() => setShowRestoreDialog(false), [])

  const [showImportDialog, setShowImportDialog] = useState(false)
  const handleImport = useCallback(() => setShowImportDialog(true), [])
  const handleCloseImportDialog = useCallback(() => setShowImportDialog(false), [])

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      setShowSubscriptionDialog(false)
      if (hours) {
        await subscribe(hours)
      } else {
        await unsubscribe()
      }
    },
    [],
  )

  const darkOrLightLabel = darkMode ? 'Always dark mode' : 'Always light mode'
  const darkModeLabel = darkMode === null ? 'System default' : darkOrLightLabel

  const onExport = useCallback(async () => {
    const json = await handleExport()
    return download(json, 'flock.backup.json')
  }, [handleExport])

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
          icon={NotificationIcon}
          id="reminders"
          onClick={handleEditSubscription}
          title="Prayer reminder notifications (temporarily unavailable)"
          disabled
        />
        <SettingsItem
          disabled={!itemCacheExists}
          icon={DeleteIcon}
          id="clear-cache"
          onClick={handleClearCache}
          title="Clear item cache"
        />
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
          title="Import people from CSV"
        />
      </List>

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
    </BasePage>
  )
}

export default SettingsPage

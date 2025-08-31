import { ReactNode, useCallback, useMemo, useState } from 'react'
import {
  Box,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  styled,
  Typography,
} from '@mui/material'
import download from 'js-file-download'
import BasePage from './BasePage'
import { useItems, useMetadata } from '../../state/selectors'
import { getNaturalPrayerGoal } from '../../utils/prayer'
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
import GoalDialog from '../dialogs/GoalDialog'
import RestoreBackupDialog from '../dialogs/RestoreBackupDialog'
import { Item } from '../../state/items'
import { useAppDispatch, useAppSelector } from '../../store'
import { setMessage, setUi } from '../../state/ui'
import { getNextDarkMode } from '../../theme'
import { subscribe, unsubscribe } from '../../utils/firebase'
import SubscriptionDialog from '../dialogs/SubscriptionDialog'
import ImportPeopleDialog from '../dialogs/ImportPeopleDialog'
import PageContainer from '../PageContainer'
import { checkItemCache, clearItemCache, exportData, signOutVault, storeItems } from '../../api/Vault'
import { setAccount } from '../../state/account'

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

function SettingsItem({
  disabled,
  icon: Icon,
  id,
  onClick,
  title,
  value = null,
}: SettingsItemProps) {
  // This is a separate object because the typing for ListItem.button is a bit finicky
  const extraListItemProps: object = {
    button: !!onClick,
  }

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

function SettingsPage() {
  const account = useAppSelector(state => state.account.account)
  const dispatch = useAppDispatch()
  const items = useItems()

  const handleSignOut = useCallback(
    () => signOutVault(),
    [dispatch],
  )

  const darkMode = useAppSelector(state => state.ui.darkMode)
  const handleToggleDarkMode = useCallback(
    () => dispatch(setUi({ darkMode: getNextDarkMode(darkMode) })),
    [darkMode, dispatch],
  )

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)

  const [showGoalDialog, setShowGoalDialog] = useState(false)
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), [])
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), [])

  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false)
  const handleEditSubscription = useCallback(() => setShowSubscriptionDialog(true), [])
  const handleCloseSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(false), [])

  const [cacheClearCounter, setCacheClearCounter] = useState(1)
  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? checkItemCache() : false),
    [cacheClearCounter],
  )
  const handleClearCache = useCallback(
    () => {
      clearItemCache()
      setCacheClearCounter(c => c + 1)
    },
    [],
  )

  const handleExport = useCallback(
    async () => {
      const data = await exportData(items)
      const json = JSON.stringify(data)
      return download(json, 'flock.backup.json')
    },
    [items],
  )

  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  const handleRestore = useCallback(() => setShowRestoreDialog(true), [])
  const handleCloseRestoreDialog = useCallback(() => setShowRestoreDialog(false), [])
  const handleConfirmRestore = useCallback(
    async (restored: Item[]) => {
      setShowRestoreDialog(false)
      await storeItems(restored)
      dispatch(setMessage({ message: 'Restore successful' }))
    },
    [dispatch],
  )

  const [showImportDialog, setShowImportDialog] = useState(false)
  const handleImport = useCallback(() => setShowImportDialog(true), [])
  const handleCloseImportDialog = useCallback(() => setShowImportDialog(false), [])
  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
      setShowImportDialog(false)
      await storeItems(imported)
      dispatch(setMessage({ message: 'Import successful' }))
    },
    [dispatch],
  )

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
          onClick={handleExport}
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

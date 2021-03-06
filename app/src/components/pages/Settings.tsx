import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  Box,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  styled,
  Theme,
  Typography,
  useMediaQuery,
} from '@mui/material';
import download from 'js-file-download';
import BasePage from './BasePage';
import { useItems, useMetadata, useVault } from '../../state/selectors';
import { getNaturalPrayerGoal } from '../../utils/prayer';
import {
  DeleteIcon,
  DownloadIcon,
  EditIcon,
  MuiIconType,
  NotificationIcon,
  PersonIcon,
  SignOutIcon,
  UploadIcon,
} from '../Icons';
import GoalDialog from '../dialogs/GoalDialog';
import TagDisplay from '../TagDisplay';
import MaturityDialog from '../dialogs/MaturityDialog';
import RestoreBackupDialog from '../dialogs/RestoreBackupDialog';
import { Item, PersonItem } from '../../state/items';
import { useAppDispatch, useAppSelector } from '../../store';
import { setMessage, setUiState } from '../../state/ui';
import { getNextDarkMode } from '../../theme';
import { clearVault } from '../../state/vault';
import { subscribe, unsubscribe } from '../../utils/firebase';
import SubscriptionDialog from '../dialogs/SubscriptionDialog';
import ImportPeopleDialog from '../dialogs/ImportPeopleDialog';
import PageContainer from '../PageContainer';

export interface SettingsItemProps {
  disabled?: boolean,
  icon?: MuiIconType,
  id: string,
  onClick?: () => void,
  title: string,
  tags?: string[],
  value?: ReactNode,
}

const LeftCheckboxLabel = styled(FormControlLabel)(({ theme }) => ({
  marginRight: 0,

  '& .MuiCheckbox-root': {
    marginLeft: theme.spacing(1),
  },
}));

function SettingsItem({
  disabled,
  icon: Icon,
  id,
  onClick,
  title,
  tags,
  value = null,
}: SettingsItemProps) {
  // This is a separate object because the typing for ListItem.button is a bit finicky
  const extraListItemProps: object = {
    button: !!onClick,
  };

  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));

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

          {tags && (
            <TagDisplay
              tags={tags}
              vertical={sm}
            />
          )}
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
  );
}

function SettingsPage() {
  const account = useAppSelector(state => state.account);
  const dispatch = useAppDispatch();
  const items = useItems();
  const vault = useVault();

  const handleSignOut = useCallback(
    () => dispatch(clearVault()),
    [dispatch],
  );

  const darkMode = useAppSelector(state => state.ui.darkMode);
  const handleToggleDarkMode = useCallback(
    () => dispatch(setUiState({ darkMode: getNextDarkMode(darkMode) })),
    [darkMode, dispatch],
  );

  const [showCommunication, setShowCommunication] = useMetadata('showCommPage', false);
  const handleToggleCommunication = useCallback(
    () => setShowCommunication(c => !c),
    [setShowCommunication],
  );

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const [goal] = useMetadata('prayerGoal', naturalGoal);

  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const [showMaturityDialog, setShowMaturityDialog] = useState(false);
  const handleEditMaturity = useCallback(() => setShowMaturityDialog(true), []);
  const handleCloseMaturityDialog = useCallback(() => setShowMaturityDialog(false), []);

  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false);
  const handleEditSubscription = useCallback(() => setShowSubscriptionDialog(true), []);
  const handleCloseSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(false), []);

  const [cacheClearCounter, setCacheClearCounter] = useState(1);
  const itemCacheExists = useMemo(
    () => (cacheClearCounter ? vault?.checkItemCache() : false),
    [cacheClearCounter, vault],
  );
  const handleClearCache = useCallback(
    () => {
      vault?.clearItemCache();
      setCacheClearCounter(c => c + 1);
    },
    [vault],
  );

  const handleExport = useCallback(
    async () => {
      const data = await vault?.exportData(items);
      const json = JSON.stringify(data);
      return download(json, 'flock.backup.json');
    },
    [items, vault],
  );

  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const handleRestore = useCallback(() => setShowRestoreDialog(true), []);
  const handleCloseRestoreDialog = useCallback(() => setShowRestoreDialog(false), []);
  const handleConfirmRestore = useCallback(
    async (restored: Item[]) => {
      setShowRestoreDialog(false);
      await vault?.store(restored);
      dispatch(setMessage({ message: 'Restore successful' }));
    },
    [dispatch, vault],
  );

  const [showImportDialog, setShowImportDialog] = useState(false);
  const handleImport = useCallback(() => setShowImportDialog(true), []);
  const handleCloseImportDialog = useCallback(() => setShowImportDialog(false), []);
  const handleConfirmImport = useCallback(
    async (imported: PersonItem[]) => {
      setShowImportDialog(false);
      await vault?.store(imported);
      dispatch(setMessage({ message: 'Import successful' }));
    },
    [dispatch, vault],
  );

  const handleSubscribe = useCallback(
    async (hours: number[] | null) => {
      setShowSubscriptionDialog(false);
      if (vault) {
        if (hours) {
          await subscribe(vault, hours);
        } else {
          await unsubscribe(vault);
        }
      }
    },
    [vault],
  );

  const darkOrLightLabel = darkMode ? 'Always dark mode' : 'Always light mode';
  const darkModeLabel = darkMode === null ? 'System default' : darkOrLightLabel;

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
          id="communication"
          onClick={handleToggleCommunication}
          title="Show Communication Page (experimental)"
          value={(
            <Checkbox
              checked={showCommunication || false}
              size="small"
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
          title="Prayer reminder notifications"
        />
        <SettingsItem
          icon={EditIcon}
          id="maturity-stages"
          onClick={handleEditMaturity}
          title="Maturity stages"
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
      <MaturityDialog
        onClose={handleCloseMaturityDialog}
        open={showMaturityDialog}
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
  );
}

export default SettingsPage;

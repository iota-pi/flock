import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  Checkbox,
  Container,
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
import makeStyles from '@mui/styles/makeStyles';
import download from 'js-file-download';
import BasePage from './BasePage';
import { useItems, useMaturity, useMetadata, useVault } from '../../state/selectors';
import { getNaturalPrayerGoal } from '../../utils/prayer';
import {
  DownloadIcon,
  EditIcon,
  MuiIconType,
  NotificationIcon,
  SignOutIcon,
  UploadIcon,
} from '../Icons';
import GoalDialog from '../dialogs/GoalDialog';
import TagDisplay from '../TagDisplay';
import MaturityDialog from '../dialogs/MaturityDialog';
import ImportDialog from '../dialogs/ImportDialog';
import { Item } from '../../state/items';
import { useAppDispatch, useAppSelector } from '../../store';
import { setMessage, setUiState } from '../../state/ui';
import { getNextDarkMode } from '../../theme';
import { clearVault } from '../../state/vault';
import { subscribe, unsubscribe } from '../../utils/firebase';
import SubscriptionDialog from '../dialogs/SubscriptionDialog';

const useStyles = makeStyles(theme => ({
  container: {
    flexGrow: 1,
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),

    '&:not(:first-child)': {
      marginTop: theme.spacing(2),
    },
  },
  heading: {
    fontWeight: 300,
  },
  action: {
    display: 'flex',
    alignItems: 'center',
  },
  grow: {
    flexGrow: 1,
  },
  goalNumber: {
    marginRight: theme.spacing(2),
    fontWeight: 500,
  },
  paddedText: {
    marginTop: theme.spacing(1),
    marginBottom: theme.spacing(1),
  },
}));

export interface SettingsItemProps {
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
  icon: Icon,
  id,
  onClick,
  title,
  tags,
  value = null,
}: SettingsItemProps) {
  const classes = useStyles();

  // This is a separate object because the typing for ListItem.button is a bit finicky
  const extraListItemProps: object = {
    button: !!onClick,
  };

  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));

  return (
    <>
      <ListItem
        {...extraListItemProps}
        disabled={!onClick}
        data-cy={id}
        onClick={onClick}
      >
        <div className={classes.grow}>
          <Typography
            className={classes.paddedText}
          >
            {title}
          </Typography>

          {tags && (
            <TagDisplay
              tags={tags}
              vertical={sm}
            />
          )}
        </div>

        <div className={classes.action}>
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
        </div>
      </ListItem>

      <Divider />
    </>
  );
}

function SettingsPage() {
  const account = useAppSelector(state => state.account);
  const classes = useStyles();
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

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);
  const [maturity] = useMaturity();

  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const [showMaturityDialog, setShowMaturityDialog] = useState(false);
  const handleEditMaturity = useCallback(() => setShowMaturityDialog(true), []);
  const handleCloseMaturityDialog = useCallback(() => setShowMaturityDialog(false), []);

  const [showSubscriptionDialog, setShowSubscriptionDialog] = useState(false);
  const handleEditSubscription = useCallback(() => setShowSubscriptionDialog(true), []);
  const handleCloseSubscriptionDialog = useCallback(() => setShowSubscriptionDialog(false), []);

  const handleExport = useCallback(
    async () => {
      const data = await vault?.exportData(items);
      const json = JSON.stringify(data);
      return download(json, 'flock.backup.json');
    },
    [items, vault],
  );

  const [showImportDialog, setShowImportDialog] = useState(false);
  const handleImport = useCallback(() => setShowImportDialog(true), []);
  const handleCloseImportDialog = useCallback(() => setShowImportDialog(false), []);
  const handleConfirmImport = useCallback(
    async (imported: Item[]) => {
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
      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading} gutterBottom>
          Settings
        </Typography>

        <Typography color="textSecondary">
          Account ID: {account}
        </Typography>
      </Container>

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
              className={classes.goalNumber}
              color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
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
          tags={maturity}
        />
        <SettingsItem
          icon={DownloadIcon}
          id="export"
          onClick={handleExport}
          title="Create a backup of your data"
        />
        <SettingsItem
          icon={UploadIcon}
          id="import"
          onClick={handleImport}
          title="Restore from a backup"
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
      <ImportDialog
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

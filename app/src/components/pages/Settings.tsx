import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  Checkbox,
  Container,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  Typography,
} from '@material-ui/core';
import makeStyles from '@material-ui/styles/makeStyles';
import download from 'js-file-download';
import BasePage from './BasePage';
import { useItems, useMetadata, useVault } from '../../state/selectors';
import { getNaturalPrayerGoal } from '../../utils/prayer';
import { DownloadIcon, EditIcon, MuiIconType, UploadIcon } from '../Icons';
import GoalDialog from '../dialogs/GoalDialog';
import TagDisplay from '../TagDisplay';
import MaturityDialog from '../dialogs/MaturityDialog';
import { DEFAULT_MATURITY } from '../../state/account';
import ImportDialog from '../dialogs/ImportDialog';
import { Item } from '../../state/items';
import { useAppDispatch, useAppSelector } from '../../store';
import { setMessage, setUiState } from '../../state/ui';
import { getNextDarkMode } from '../../theme';

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
            <TagDisplay tags={tags} />
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

  const darkMode = useAppSelector(state => state.ui.darkMode);
  const handleToggleDarkMode = useCallback(
    () => dispatch(setUiState({ darkMode: getNextDarkMode(darkMode) })),
    [darkMode, dispatch],
  );

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);
  const [maturity] = useMetadata<string[]>('maturity', DEFAULT_MATURITY);

  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const [showMaturityDialog, setShowMaturityDialog] = useState(false);
  const handleEditMaturity = useCallback(() => setShowMaturityDialog(true), []);
  const handleCloseMaturityDialog = useCallback(() => setShowMaturityDialog(false), []);

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
          id="import"
          onClick={handleToggleDarkMode}
          title="Use dark mode"
          value={(
            <FormControlLabel
              control={(
                <Checkbox
                  indeterminate={darkMode === null}
                  checked={darkMode || false}
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
    </BasePage>
  );
}

export default SettingsPage;

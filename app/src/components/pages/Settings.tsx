import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  Container,
  Divider,
  IconButton,
  List,
  ListItem,
  makeStyles,
  Typography,
} from '@material-ui/core';
import BasePage from './BasePage';
import { useItems, useMetadata } from '../../state/selectors';
import { getNaturalPrayerGoal } from '../../utils/prayer';
import { EditIcon } from '../Icons';
import GoalDialog from '../dialogs/GoalDialog';
import TagDisplay from '../TagDisplay';
import MaturityDialog from '../dialogs/MaturityDialog';
import { DEFAULT_MATURITY } from '../../state/account';

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
  id: string,
  onClick: () => void,
  title: string,
  tags?: string[],
  value?: ReactNode,
}

function SettingsItem({
  id,
  onClick,
  title,
  tags,
  value = null,
}: SettingsItemProps) {
  const classes = useStyles();

  return (
    <>
      <ListItem
        button
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

          <IconButton
            data-cy="edit-button"
            disableRipple
            size="medium"
          >
            <EditIcon fontSize="small" />
          </IconButton>
        </div>
      </ListItem>

      <Divider />
    </>
  );
}

function SettingsPage() {
  const classes = useStyles();
  const items = useItems();

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);
  const [maturity] = useMetadata<string[]>('maturity', DEFAULT_MATURITY);

  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const [showMaturityDialog, setShowMaturityDialog] = useState(false);
  const handleEditMaturity = useCallback(() => setShowMaturityDialog(true), []);
  const handleCloseMaturityDialog = useCallback(() => setShowMaturityDialog(false), []);

  return (
    <BasePage>
      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading}>
          Settings
        </Typography>
      </Container>

      <Divider />

      <List>
        <SettingsItem
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
          id="maturity-stages"
          onClick={handleEditMaturity}
          title="Maturity stages"
          tags={maturity}
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
    </BasePage>
  );
}

export default SettingsPage;

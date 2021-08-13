import React, { useCallback, useMemo, useState } from 'react';
import {
  Container,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
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

function SettingsPage() {
  const classes = useStyles();
  const items = useItems();

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);
  const [maturity] = useMetadata<string[]>('maturity', DEFAULT_MATURITY);

  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const handleEditMaturity = useCallback(() => setShowGoalDialog(true), []);

  return (
    <BasePage>
      <Container maxWidth="xl" className={classes.container}>
        <Typography variant="h4" className={classes.heading}>
          Settings
        </Typography>
      </Container>

      <Divider />

      <List>
        <ListItem
          button
          onClick={handleEditGoal}
        >
          <ListItemText
            primary="Daily prayer goal"
          />

          <div className={classes.action}>
            <Typography
              className={classes.goalNumber}
              color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
            >
              {goal}
            </Typography>

            <IconButton size="medium">
              <EditIcon fontSize="small" />
            </IconButton>
          </div>
        </ListItem>

        <Divider />

        <ListItem
          button
          onClick={handleEditMaturity}
        >
          <div className={classes.grow}>
            <Typography
              className={classes.paddedText}
            >
              Maturity stages
            </Typography>
            <TagDisplay tags={maturity} />
          </div>

          <IconButton size="medium">
            <EditIcon fontSize="small" />
          </IconButton>
        </ListItem>

        <Divider />
      </List>

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />

      <MaturityDialog
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  );
}

export default SettingsPage;

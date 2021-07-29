import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, Divider, Grid, IconButton, Typography } from '@material-ui/core';
import { useItems, useMetadata, useVault } from '../../state/selectors';
import { isSameDay } from '../../utils';
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../../utils/prayer';
import ItemList from '../ItemList';
import { Item, updateItems } from '../../state/items';
import { useAppDispatch } from '../../store';
import { EditIcon } from '../Icons';
import GoalDialog from '../GoalDialog';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';

const useStyles = makeStyles(theme => ({
  root: {
    flexGrow: 1,
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
  heading: {
    fontWeight: 300,
  },
  flexRightLarge: {
    display: 'flex',
    alignItems: 'center',

    [theme.breakpoints.up('md')]: {
      justifyContent: 'flex-end',
    },
  },
}));


function PrayerPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const vault = useVault();

  const [showGoalDialog, setShowGoalDialog] = useState(false);

  const prayedForToday = useMemo(
    () => (
      items.filter(
        item => isSameDay(new Date(), new Date(getLastPrayedFor(item))),
      )
    ),
    [items],
  );
  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const prayerSchedule = useMemo(() => getPrayerSchedule(items), [items]);
  const completed = prayedForToday.length;
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);
  const todaysSchedule = useMemo(
    () => prayerSchedule.slice(0, goal),
    [prayerSchedule, goal],
  );
  const upNextSchedule = useMemo(
    () => prayerSchedule.slice(goal),
    [prayerSchedule, goal],
  );

  const isPrayedForToday = useCallback(
    (item: Item) => prayedForToday.findIndex(i => i.id === item.id) >= 0,
    [prayedForToday],
  );
  const recordPrayerFor = useCallback(
    (item: Item, toggle = false) => {
      let prayedFor = item.prayedFor;
      if (isPrayedForToday(item)) {
        if (toggle) {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          prayedFor = prayedFor.filter(d => d < startOfDay.getTime());
        }
      } else {
        prayedFor = [...prayedFor, new Date().getTime()];
      }
      const newItem: Item = { ...item, prayedFor };
      vault?.store(newItem);
      dispatch(updateItems([newItem]));
    },
    [dispatch, isPrayedForToday, vault],
  );
  const handleClickPrayedFor = useCallback(
    (item: Item) => () => recordPrayerFor(item, true),
    [recordPrayerFor],
  );

  const handleClick = useCallback(
    (item: Item) => () => {
      const index = prayerSchedule.indexOf(item);
      const endIndex = index < goal ? goal : prayerSchedule.length;
      const next = prayerSchedule.slice(index + 1, endIndex);
      dispatch(updateActive({ item, next, praying: true, report: true }));
    },
    [dispatch, goal, prayerSchedule],
  );
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  return (
    <BasePage>
      <Container maxWidth="xl" className={classes.root}>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}>
            <Typography variant="h4" className={classes.heading}>
              Today
            </Typography>
          </Grid>

          <Grid item xs={12} md={6} className={classes.flexRightLarge}>
            <Typography>
              Daily Goal:
            </Typography>
            <span>&nbsp;</span>
            <Typography color="secondary">
              {completed} / {goal}
            </Typography>
            <span>&nbsp;&nbsp;</span>

            <IconButton size="medium" onClick={handleEditGoal}>
              <EditIcon fontSize="small" />
            </IconButton>
          </Grid>

          <Grid item xs={12}>
            <ItemList
              checkboxes
              checkboxSide="right"
              getChecked={isPrayedForToday}
              getFaded={isPrayedForToday}
              items={todaysSchedule}
              onClick={handleClick}
              onCheck={handleClickPrayedFor}
              noItemsText="No items in prayer schedule"
              showIcons
            />
          </Grid>

          {upNextSchedule.length > 0 && (
            <>
              <Grid item xs={12}>
                <Divider />
              </Grid>

              <Grid item xs={12}>
                <Typography variant="h4" className={classes.heading}>
                  Up next
                </Typography>
              </Grid>

              <Grid item xs={12}>
                <ItemList
                  checkboxes
                  checkboxSide="right"
                  getChecked={isPrayedForToday}
                  getFaded={isPrayedForToday}
                  items={upNextSchedule}
                  onClick={handleClick}
                  onCheck={handleClickPrayedFor}
                  noItemsText="No more items in prayer schedule"
                  showIcons
                />
              </Grid>
            </>
          )}
        </Grid>
      </Container>

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  );
}

export default PrayerPage;

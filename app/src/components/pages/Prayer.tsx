import { Fragment, useCallback, useMemo, useState } from 'react';
import makeStyles from '@mui/styles/makeStyles';
import { Container, Divider, Grid, IconButton, Theme, Typography, useMediaQuery } from '@mui/material';
import { AutoSizer } from 'react-virtualized';
import { useItemMap, useItems, useMetadata, useVault } from '../../state/selectors';
import { isSameDay, useStringMemo } from '../../utils';
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../../utils/prayer';
import ItemList, { ItemListExtraElement } from '../ItemList';
import { getBlankPrayerPoint, Item } from '../../state/items';
import { useAppDispatch } from '../../store';
import { EditIcon } from '../Icons';
import GoalDialog from '../dialogs/GoalDialog';
import BasePage from './BasePage';
import { replaceActive } from '../../state/ui';

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
  flexRightLarge: {
    display: 'flex',
    alignItems: 'center',

    [theme.breakpoints.up('sm')]: {
      justifyContent: 'flex-end',
    },
  },
}));


function isPrayedForToday(item: Item): boolean {
  return isSameDay(new Date(), new Date(getLastPrayedFor(item)));
}


function PrayerPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const itemMap = useItemMap();
  const vault = useVault();

  const [showGoalDialog, setShowGoalDialog] = useState(false);

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const rawPrayerSchedule = useMemo(() => getPrayerSchedule(items), [items]);
  const memoisedPrayerSchedule = useStringMemo(rawPrayerSchedule);
  const completed = useMemo(
    () => items.filter(isPrayedForToday).length,
    [items],
  );
  const [goal] = useMetadata('prayerGoal', naturalGoal);
  const schedule = useMemo(
    () => memoisedPrayerSchedule.map(i => itemMap[i]),
    [itemMap, memoisedPrayerSchedule],
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
    },
    [vault],
  );
  const handleClickPrayedFor = useCallback(
    (item: Item) => recordPrayerFor(item, true),
    [recordPrayerFor],
  );

  const handleClick = useCallback(
    (item: Item) => {
      const index = memoisedPrayerSchedule.indexOf(item.id);
      const endIndex = index < goal ? goal : memoisedPrayerSchedule.length;
      const next = memoisedPrayerSchedule.slice(index + 1, endIndex);
      dispatch(replaceActive({ item: item.id, next, praying: true, report: true }));
    },
    [dispatch, goal, memoisedPrayerSchedule],
  );
  const handleClickAdd = useCallback(
    () => dispatch(replaceActive({ newItem: getBlankPrayerPoint() })),
    [dispatch],
  );
  const handleEditGoal = useCallback(() => setShowGoalDialog(true), []);
  const handleCloseGoalDialog = useCallback(() => setShowGoalDialog(false), []);

  const xs = useMediaQuery<Theme>(theme => theme.breakpoints.down('sm'));
  const sm = useMediaQuery<Theme>(theme => theme.breakpoints.down('md'));
  const maxTags = sm ? (2 - +xs) : 3;

  const extraElements: ItemListExtraElement[] = useMemo(
    () => [
      {
        content: (
          <Fragment key="heading-today">
            <Container maxWidth="xl" className={classes.container}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <Typography variant="h4" className={classes.heading}>
                    Today
                  </Typography>
                </Grid>

                <Grid item xs={12} sm={6} className={classes.flexRightLarge}>
                  <Typography>
                    {'Daily Goal: '}
                    {completed}
                    {' / '}
                    <Typography
                      color={goal < naturalGoal ? 'secondary' : 'textPrimary'}
                      component="span"
                    >
                      {goal}
                    </Typography>
                  </Typography>
                  <span>&nbsp;&nbsp;</span>

                  <IconButton size="medium" onClick={handleEditGoal}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Grid>
              </Grid>
            </Container>

            <Divider />
          </Fragment>
        ),
        height: xs ? 126 : 74,
        index: 0,
      },
      {
        content: schedule.length > goal && (
          <Fragment key="heading-up-next">
            <Container maxWidth="xl" className={classes.container}>
              <Typography variant="h4" className={classes.heading}>
                Up next
              </Typography>
            </Container>

            <Divider />
          </Fragment>
        ),
        height: 74,
        index: goal,
      },
    ],
    [classes, completed, goal, handleEditGoal, naturalGoal, schedule.length, xs],
  );

  return (
    <BasePage
      fab
      fabLabel="Add prayer point"
      noScrollContainer
      onClickFab={handleClickAdd}
    >
      <AutoSizer disableWidth>
        {({ height }) => (
          <ItemList
            checkboxes
            checkboxSide="right"
            extraElements={extraElements}
            getChecked={isPrayedForToday}
            getForceFade={isPrayedForToday}
            items={schedule}
            maxTags={maxTags}
            onClick={handleClick}
            onCheck={handleClickPrayedFor}
            noItemsText="No items in prayer schedule"
            showIcons
            viewHeight={height}
          />
        )}
      </AutoSizer>

      <GoalDialog
        naturalGoal={naturalGoal}
        onClose={handleCloseGoalDialog}
        open={showGoalDialog}
      />
    </BasePage>
  );
}

export default PrayerPage;

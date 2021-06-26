import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, Grid, Typography } from '@material-ui/core';
import { useItems, useMetadata, useVault } from '../../state/selectors';
import { isSameDay } from '../../utils';
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../../utils/prayer';
import ItemList from '../ItemList';
import { Item, updateItems } from '../../state/items';
import { useAppDispatch } from '../../store';
import ReportDrawer from '../drawers/ReportDrawer';

const useStyles = makeStyles(theme => ({
  root: {
    paddingTop: theme.spacing(2),
    paddingBottom: theme.spacing(2),
  },
  heading: {
    fontWeight: 300,
  },
  flexRight: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
}));


function PrayerPage() {
  const classes = useStyles();
  const dispatch = useAppDispatch();
  const items = useItems();
  const vault = useVault();

  const [currentItem, setCurrentItem] = useState<Item>();
  const [showDrawer, setShowDrawer] = useState(false);

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

  const isPrayedForToday = useCallback(
    (item: Item) => prayedForToday.findIndex(i => i.id === item.id) >= 0,
    [prayedForToday],
  );
  const handlePrayedFor = useCallback(
    (item: Item) => () => {
      let prayedFor = item.prayedFor;
      if (isPrayedForToday(item)) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        prayedFor = prayedFor.filter(d => d < startOfDay.getTime());
      } else {
        prayedFor = [...prayedFor, new Date().getTime()];
      }
      const newItem: Item = { ...item, prayedFor };
      vault?.store(newItem);
      dispatch(updateItems([newItem]));
    },
    [dispatch, isPrayedForToday, vault],
  );

  const handleClick = useCallback(
    (item: Item) => () => {
      setCurrentItem(item);
      setShowDrawer(true);
    },
    [],
  );
  const handleClose = useCallback(() => setShowDrawer(false), []);

  return (
    <Container maxWidth="xl" className={classes.root}>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={8}>
          <Typography variant="h3" className={classes.heading}>
            Prayer Schedule
          </Typography>
        </Grid>

        <Grid item xs={12} sm={4} className={classes.flexRight}>
          <Typography>
            Daily Goal:
          </Typography>
          <span>&nbsp;</span>
          <Typography color="secondary">
            {completed} / {goal}
          </Typography>
        </Grid>

        <Grid item xs={12}>
          <ItemList
            checkboxes
            getChecked={isPrayedForToday}
            items={prayerSchedule}
            onClick={handleClick}
            onCheck={handlePrayedFor}
            noItemsText="No items in prayer schedule"
          />
        </Grid>
      </Grid>

      {currentItem && (
        <ReportDrawer
          canEdit
          item={currentItem}
          open={showDrawer}
          onClose={handleClose}
        />
      )}
    </Container>
  );
}

export default PrayerPage;

import React, { useMemo } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Container, Grid, Typography } from '@material-ui/core';
import { useItems, useMetadata } from '../../state/selectors';
import { formatDate } from '../../utils';
import { getNaturalPrayerGoal } from '../../utils/prayer';

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
  const items = useItems();

  const prayedForToday = useMemo(
    () => (
      items.filter(
        item => formatDate(new Date()) === formatDate(new Date(item.lastPrayedFor || 0)),
      )
    ),
    [items],
  );
  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items]);
  const completed = prayedForToday.length;
  const [goal] = useMetadata<number>('prayerGoal', naturalGoal);

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
          hi
        </Grid>
      </Grid>
    </Container>
  );
}

export default PrayerPage;

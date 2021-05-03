import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';

const useStyles = makeStyles(() => ({
  root: {},
}));


function PrayerPage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      Prayer
    </div>
  );
}

export default PrayerPage;

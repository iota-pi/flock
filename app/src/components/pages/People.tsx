import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';

const useStyles = makeStyles(() => ({
  root: {},
}));


function PeoplePage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      People
    </div>
  );
}

export default PeoplePage;

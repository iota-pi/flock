import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';

const useStyles = makeStyles(() => ({
  root: {},
}));


function InteractionsPage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      Interactions
    </div>
  );
}

export default InteractionsPage;

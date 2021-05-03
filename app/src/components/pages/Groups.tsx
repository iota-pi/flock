import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';

const useStyles = makeStyles(() => ({
  root: {},
}));


function GroupsPage() {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      Groups
    </div>
  );
}

export default GroupsPage;

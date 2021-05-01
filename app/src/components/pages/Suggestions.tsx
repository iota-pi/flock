import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';

const useStyles = makeStyles(() => ({
  root: {},
}));


function SuggestionsPage() {
  const classes = useStyles();

  return (
    <div
      className={classes.root}
    >
      Suggestions
    </div>
  );
}

export default SuggestionsPage;

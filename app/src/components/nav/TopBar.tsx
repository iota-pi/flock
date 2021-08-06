import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Checkbox, Paper } from '@material-ui/core';

const useStyles = makeStyles(theme => ({
  root: {
    padding: theme.spacing(2),
  },
}));

interface Props {
  allSelected?: boolean,
  onSelectAll?: () => void,
}


function TopBar({
  allSelected = false,
  onSelectAll,
}: Props) {
  const classes = useStyles();

  return (
    <Paper className={classes.root}>
      {onSelectAll && (
        <Checkbox
          checked={allSelected}
          onClick={onSelectAll}
        />
      )}
    </Paper>
  );
}

export default TopBar;

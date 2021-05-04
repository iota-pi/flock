import React from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { useAppSelector } from '../../store';
import { PersonItem } from '../../state/items';

const useStyles = makeStyles(theme => ({
  root: {
    position: 'relative',
    flexGrow: 1,
  },
  fab: {
    position: 'absolute',
    bottom: theme.spacing(2),
    right: theme.spacing(2),
  },
}));


function PeoplePage() {
  const classes = useStyles();
  const items = useAppSelector(state => state.items);
  const people = items.filter(item => item.type === 'person') as PersonItem[];

  return (
    <div className={classes.root}>
      {people}

      <Fab aria-label="Add Person" className={classes.fab}>
        <AddIcon />
      </Fab>
    </div>
  );
}

export default PeoplePage;

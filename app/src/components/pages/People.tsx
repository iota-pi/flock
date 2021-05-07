import React, { useCallback, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { useAppSelector } from '../../store';
import { PersonItem } from '../../state/items';
import PersonDrawer from '../drawers/Person';

const useStyles = makeStyles(theme => ({
  root: {
    position: 'relative',
    flexGrow: 1,
  },
  fab: {
    position: 'absolute',
    bottom: theme.spacing(3),
    right: theme.spacing(3),
  },
}));


function PeoplePage() {
  const classes = useStyles();
  const items = useAppSelector(state => state.items);
  const people = items.filter(item => item.type === 'person') as PersonItem[];

  const [showDetails, setShowDetails] = useState(false);
  const currentPerson: PersonItem | undefined = undefined;

  const handleClickAdd = useCallback(() => setShowDetails(true), []);
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <div className={classes.root}>
      {JSON.stringify(people)}

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Person"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <PersonDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        person={currentPerson}
      />
    </div>
  );
}

export default PeoplePage;

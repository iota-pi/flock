import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { comparePeopleNames, PersonItem } from '../../state/items';
import PersonDrawer from '../drawers/Person';
import ItemList from '../ItemList';
import { useItems } from '../../state/selectors';

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
  chevronButton: {
    '&:hover': {
      backgroundColor: 'transparent',
    },
  },
}));


function PeoplePage() {
  const classes = useStyles();
  const rawPeople = useItems<PersonItem>('person');
  const people = useMemo(() => rawPeople.slice().sort(comparePeopleNames), [rawPeople]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentPerson, setCurrentPerson] = useState<PersonItem>();

  const handleClickPerson = useCallback(
    (person: PersonItem) => () => {
      setShowDetails(true);
      setCurrentPerson(person);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentPerson(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <div className={classes.root}>
      <ItemList
        items={people}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No people found"
        onClick={handleClickPerson}
      />

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

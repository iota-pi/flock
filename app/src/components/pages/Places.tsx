import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { compareNames, PlaceItem } from '../../state/items';
import ItemList from '../ItemList';
import PlaceDrawer from '../drawers/Place';
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
}));


function PlacePage() {
  const classes = useStyles();
  const rawPlaces = useItems<PlaceItem>('place');
  const places = useMemo(() => rawPlaces.sort(compareNames), [rawPlaces]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentPlace, setCurrentPlace] = useState<PlaceItem>();

  const handleClickPlace = useCallback(
    (place: PlaceItem) => () => {
      setShowDetails(true);
      setCurrentPlace(place);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentPlace(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <div className={classes.root}>
      <ItemList
        items={places}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No places found"
        onClick={handleClickPlace}
      />

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Place"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <PlaceDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        item={currentPlace}
      />
    </div>
  );
}

export default PlacePage;

import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import { compareNames, EventItem } from '../../state/items';
import ItemList from '../ItemList';
import EventDrawer from '../drawers/Event';
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


function EventsPage() {
  const classes = useStyles();
  const rawEvents = useItems<EventItem>('event');
  const events = useMemo(() => rawEvents.sort(compareNames), [rawEvents]);

  const [showDetails, setShowDetails] = useState(false);
  const [currentEvent, setCurrentEvent] = useState<EventItem>();

  const handleClickEvent = useCallback(
    (event: EventItem) => () => {
      setShowDetails(true);
      setCurrentEvent(event);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setShowDetails(true);
      setCurrentEvent(undefined);
    },
    [],
  );
  const handleCloseDetails = useCallback(() => setShowDetails(false), []);

  return (
    <div className={classes.root}>
      <ItemList
        items={events}
        noItemsHint="Click the plus button to add one!"
        noItemsText="No events found"
        onClick={handleClickEvent}
      />

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Event"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <EventDrawer
        open={showDetails}
        onClose={handleCloseDetails}
        event={currentEvent}
      />
    </div>
  );
}

export default EventsPage;

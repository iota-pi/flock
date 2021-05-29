import React, { useCallback, useMemo, useState } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareNotes, getNotes, ItemNote } from '../../state/items';
import InteractionDrawer from '../drawers/Interaction';

const useStyles = makeStyles(theme => ({
  root: {},
  fab: {
    position: 'absolute',
    bottom: theme.spacing(3),
    right: theme.spacing(3),
  },
}));


function InteractionsPage() {
  const classes = useStyles();
  const items = useItems();

  const [showDrawer, setShowDrawer] = useState(false);
  const [currentInteraction, setCurrentInteraction] = useState<ItemNote<'interaction'>>();
  const notes = useMemo(() => getNotes(items, 'interaction').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: ItemNote<'interaction'>) => () => {
      setCurrentInteraction(note);
      setShowDrawer(true);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setCurrentInteraction(undefined);
      setShowDrawer(true);
    },
    [],
  );
  const handleCloseDrawer = useCallback(() => setShowDrawer(false), []);

  return (
    <div className={classes.root}>
      <NoteList
        notes={notes}
        noNotesHint="Click the plus button to add one!"
        noNotesText="No interactions found"
        onClick={handleClickNote}
      />

      <Fab
        onClick={handleClickAdd}
        color="secondary"
        aria-label="Add Interaction"
        className={classes.fab}
      >
        <AddIcon />
      </Fab>

      <InteractionDrawer
        interaction={currentInteraction}
        onClose={handleCloseDrawer}
        open={showDrawer}
      />
    </div>
  );
}

export default InteractionsPage;

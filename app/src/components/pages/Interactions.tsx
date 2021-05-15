import React, { useCallback, useMemo } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Fab } from '@material-ui/core';
import AddIcon from '@material-ui/icons/Add';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareNotes, getNotes, ItemNote } from '../../state/items';

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

  const notes = useMemo(() => getNotes(items, 'interaction').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: ItemNote) => () => {
      console.warn(note);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {

    },
    [],
  );

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
    </div>
  );
}

export default InteractionsPage;

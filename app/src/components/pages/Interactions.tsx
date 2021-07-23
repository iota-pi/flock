import React, { useCallback, useMemo } from 'react';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareNotes, getBlankInteraction, getNotes, InteractionNote } from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function InteractionsPage() {
  const dispatch = useAppDispatch();
  const items = useItems();

  const notes = useMemo(() => getNotes(items, 'interaction').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: InteractionNote) => () => {
      dispatch(updateActive({ item: note }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankInteraction() }));
    },
    [dispatch],
  );

  return (
    <BasePage
      fab
      fabLabel="Add Interaction"
      onClickFab={handleClickAdd}
    >
      <NoteList
        notes={notes}
        noNotesHint="Click the plus button to add one!"
        noNotesText="No interactions found"
        onClick={handleClickNote}
      />
    </BasePage>
  );
}

export default InteractionsPage;

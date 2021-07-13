import React, { useCallback, useMemo, useState } from 'react';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareNotes, getNotes, InteractionNote } from '../../state/items';
import InteractionDrawer from '../drawers/Interaction';
import BasePage from './BasePage';


function InteractionsPage() {
  const items = useItems();

  const [showDrawer, setShowDrawer] = useState(false);
  const [currentInteraction, setCurrentInteraction] = useState<InteractionNote>();
  const notes = useMemo(() => getNotes(items, 'interaction').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: InteractionNote) => () => {
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

      <InteractionDrawer
        interaction={currentInteraction}
        onClose={handleCloseDrawer}
        open={showDrawer}
      />
    </BasePage>
  );
}

export default InteractionsPage;

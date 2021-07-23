import React, { useCallback, useMemo } from 'react';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareItems, compareNotes, getBlankPrayerPoint, getNotes, PrayerNote } from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function PrayerPointsPage() {
  const dispatch = useAppDispatch();
  const rawItems = useItems();

  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);
  const notes = useMemo(() => getNotes(items, 'prayer').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: PrayerNote) => () => {
      dispatch(updateActive({ item: note }));
    },
    [dispatch],
  );
  const handleClickAdd = useCallback(
    () => {
      dispatch(updateActive({ item: getBlankPrayerPoint() }));
    },
    [dispatch],
  );

  return (
    <BasePage
      fab
      fabLabel="Add Prayer Point"
      onClickFab={handleClickAdd}
    >
      <NoteList
        notes={notes}
        noNotesHint="Click the plus button to add one!"
        noNotesText="No prayer points found"
        onClick={handleClickNote}
      />
    </BasePage>
  );
}

export default PrayerPointsPage;

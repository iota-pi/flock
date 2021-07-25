import React, { useCallback, useMemo } from 'react';
import NoteList from '../NoteList';
import { useIsActive, useItems } from '../../state/selectors';
import { compareItems, compareNotes, getBlankPrayerPoint, getNotes, PrayerNote } from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';


function PrayerPointsPage() {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawItems = useItems();

  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);
  const notes = useMemo(() => getNotes(items, 'prayer').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: PrayerNote) => () => {
      if (!isActive(note)) {
        dispatch(updateActive({ item: note }));
      }
    },
    [dispatch, isActive],
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
        getHighlighted={isActive}
        notes={notes}
        noNotesHint="Click the plus button to add one!"
        noNotesText="No prayer points found"
        onClick={handleClickNote}
        showIcons
      />
    </BasePage>
  );
}

export default PrayerPointsPage;

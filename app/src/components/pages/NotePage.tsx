import React, { useCallback, useMemo } from 'react';
import NoteList from '../NoteList';
import { useIsActive, useItems } from '../../state/selectors';
import {
  compareItems,
  compareNotes,
  getBlankPrayerPoint,
  getNotes,
  getNoteTypeLabel,
  ItemNote,
  ItemNoteType,
} from '../../state/items';
import BasePage from './BasePage';
import { updateActive } from '../../state/ui';
import { useAppDispatch } from '../../store';

export interface Props<T extends ItemNoteType> {
  noteType: T,
}

function NotePage<T extends ItemNoteType>({
  noteType,
}: Props<T>) {
  const dispatch = useAppDispatch();
  const isActive = useIsActive();
  const rawItems = useItems();

  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);
  const notes = useMemo(
    () => getNotes(items, noteType).sort(compareNotes),
    [items, noteType],
  );

  const handleClickNote = useCallback(
    (note: ItemNote) => () => {
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
      fabLabel={`Add ${getNoteTypeLabel(noteType, true)}`}
      onClickFab={handleClickAdd}
    >
      <NoteList
        getHighlighted={isActive}
        notes={notes}
        noNotesHint="Click the plus button to add one!"
        noNotesText={`No ${getNoteTypeLabel(noteType).toLowerCase()} found`}
        onClick={handleClickNote}
        showIcons
      />
    </BasePage>
  );
}

export default NotePage;

import React, { useCallback, useMemo, useState } from 'react';
import NoteList from '../NoteList';
import { useItems } from '../../state/selectors';
import { compareItems, compareNotes, getNotes, PrayerNote } from '../../state/items';
import PrayerPointDrawer from '../drawers/PrayerPoint';
import BasePage from './BasePage';


function PrayerPointsPage() {
  const rawItems = useItems();

  const [showDrawer, setShowDrawer] = useState(false);
  const [currentPrayerPoint, setPrayerPoint] = useState<PrayerNote>();
  const items = useMemo(() => rawItems.sort(compareItems), [rawItems]);
  const notes = useMemo(() => getNotes(items, 'prayer').sort(compareNotes), [items]);

  const handleClickNote = useCallback(
    (note: PrayerNote) => () => {
      setPrayerPoint(note);
      setShowDrawer(true);
    },
    [],
  );
  const handleClickAdd = useCallback(
    () => {
      setPrayerPoint(undefined);
      setShowDrawer(true);
    },
    [],
  );
  const handleCloseDrawer = useCallback(() => setShowDrawer(false), []);

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

      <PrayerPointDrawer
        prayerPoint={currentPrayerPoint}
        onClose={handleCloseDrawer}
        open={showDrawer}
      />
    </BasePage>
  );
}

export default PrayerPointsPage;

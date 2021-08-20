import { useCallback, useEffect, useState } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { isItem, ItemOrNote } from '../../state/items';
import { DrawerData, removeActive, replaceActive } from '../../state/ui';
import { useAppDispatch, useAppSelector } from '../../store';
import ItemDrawer from '../drawers/ItemDrawer';
import PlaceholderDrawer from '../drawers/Placeholder';
import ReportDrawer from '../drawers/ReportDrawer';
import NoteDrawer from '../drawers/NoteDrawer';
import { useItemOrNote } from '../../state/selectors';
import { getItemId } from '../../utils';

function IndividualDrawer({
  drawer,
  onClose,
  onExited,
  stacked,
}: {
  drawer: DrawerData,
  onClose: () => void,
  onExited: () => void,
  stacked: boolean,
}) {
  const existingItem = useItemOrNote(drawer.item || getItemId());
  const item = existingItem || drawer.newItem;

  const [localItem, setLocalItem] = useState<ItemOrNote | undefined>(item);
  const handleChange = useCallback(
    (data: ItemOrNote) => setLocalItem(data),
    [],
  );

  useEffect(() => setLocalItem(item), [item]);

  if (localItem) {
    if (isItem(localItem)) {
      return drawer.report ? (
        <ReportDrawer
          item={localItem}
          next={drawer.next}
          onBack={onClose}
          onClose={onClose}
          onExited={onExited}
          open={drawer.open}
          praying={drawer.praying}
          stacked={stacked}
        />
      ) : (
        <ItemDrawer
          item={localItem}
          onBack={onClose}
          onChange={handleChange}
          onClose={onClose}
          onExited={onExited}
          open={drawer.open}
          stacked={stacked}
        />
      );
    }

    return (
      <NoteDrawer
        linkedItems={drawer.initial?.filter(isItem)}
        note={localItem}
        onChange={handleChange}
        onClose={onClose}
        onExited={onExited}
        open={drawer.open}
        stacked={stacked}
      />
    );
  }

  return null;
}

function DrawerDisplay() {
  const dispatch = useAppDispatch();
  const drawers = useAppSelector(state => state.ui.drawers);

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'));

  const handleClose = useCallback(
    () => dispatch(replaceActive({ open: false })),
    [dispatch],
  );
  const handleExited = useCallback(
    () => dispatch(removeActive()),
    [dispatch],
  );
  const onClose = baseDrawerIsPermanent && drawers.length === 1 ? handleExited : handleClose;

  return (
    <>
      {drawers.map((drawer, i) => (
        <IndividualDrawer
          key={drawer.id}
          drawer={drawer}
          onClose={onClose}
          onExited={handleExited}
          stacked={i > 0}
        />
      ))}

      {drawers.length === 0 && baseDrawerIsPermanent && (
        <PlaceholderDrawer
          open
          onClose={() => {}}
        />
      )}
    </>
  );
}

export default DrawerDisplay;

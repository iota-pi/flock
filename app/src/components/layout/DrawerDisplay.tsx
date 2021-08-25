import { Theme, useMediaQuery } from '@material-ui/core';
import { useCallback, useEffect, useState } from 'react';
import { useHistory } from 'react-router-dom';
import { isItem, ItemOrNote } from '../../state/items';
import { DrawerData, removeActive, updateActive } from '../../state/ui';
import { useAppDispatch, useAppSelector } from '../../store';
import ItemDrawer from '../drawers/ItemDrawer';
import PlaceholderDrawer from '../drawers/Placeholder';
import ReportDrawer from '../drawers/ReportDrawer';
import NoteDrawer from '../drawers/NoteDrawer';
import { useItemOrNote } from '../../state/selectors';
import { getItemId, usePrevious } from '../../utils';

function useDrawerRouting(drawers: DrawerData[]) {
  const dispatch = useAppDispatch();
  const history = useHistory();
  const prevDrawers = usePrevious(drawers);

  useEffect(
    () => {
      if (prevDrawers) {
        const topIndex = drawers.length - 1;
        const topItem = drawers[topIndex]?.item;
        const prevTopItem = prevDrawers[prevDrawers.length - 1]?.item;
        const currentHashItem = history.location.hash.replace(/^#/, '');
        if (drawers.length === prevDrawers.length) {
          if (topItem && topItem !== prevTopItem) {
            history.replace(`#${topItem}`);
          }
        } else if (drawers.length < prevDrawers.length && prevTopItem === currentHashItem) {
          history.goBack();
        } else if (drawers.length > prevDrawers.length && topItem) {
          history.push(`#${topItem}`);
        }
      }
    },
    [drawers, history, prevDrawers],
  );

  const secondTopItem = drawers[drawers.length - 2]?.item;
  useEffect(
    () => {
      const onLocationChange = ({ hash }: { hash: string }) => {
        const id = hash.replace(/^#/, '');
        if (secondTopItem === id) {
          dispatch(removeActive());
        } else if (!hash && drawers.length > 0) {
          dispatch(removeActive());
        }
      };
      const cleanup = history.listen(onLocationChange);
      return cleanup;
    },
    [dispatch, drawers.length, history, secondTopItem],
  );

  useEffect(
    () => {
      history.replace(history.location.pathname);
    },
    [history],
  );
}

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
    (data: Partial<Omit<ItemOrNote, 'type' | 'id'>>) => setLocalItem(prevItem => {
      if (prevItem) {
        return { ...prevItem, ...data } as ItemOrNote;
      }
      return undefined;
    }),
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
        onBack={onClose}
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
    () => dispatch(updateActive({ open: false })),
    [dispatch],
  );
  const handleExited = useCallback(
    () => dispatch(removeActive()),
    [dispatch],
  );
  const onClose = baseDrawerIsPermanent && drawers.length === 1 ? handleExited : handleClose;

  useDrawerRouting(drawers);

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

import { Theme, useMediaQuery } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isItem, isNote, TypedFlockItem } from '../../state/items';
import { DrawerData, removeActive, updateActive } from '../../state/ui';
import { useAppDispatch, useAppSelector } from '../../store';
import ItemDrawer from '../drawers/ItemDrawer';
import PlaceholderDrawer from '../drawers/Placeholder';
import ReportDrawer from '../drawers/ReportDrawer';
import NoteDrawer from '../drawers/NoteDrawer';
import { useItemOrNote, useLoggedIn, useMessageItem } from '../../state/selectors';
import { getItemId, usePrevious } from '../../utils';
import EditMessageDrawer from '../drawers/EditMessageDrawer';
import { usePage } from '../pages';
import MessageDrawer from '../drawers/MessageDrawer';

function useDrawerRouting(drawers: DrawerData[]) {
  const dispatch = useAppDispatch();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const prevDrawers = usePrevious(drawers);

  useEffect(
    () => {
      if (prevDrawers) {
        const topIndex = drawers.length - 1;
        const topItem = drawers[topIndex]?.item;
        const prevTopItem = prevDrawers[prevDrawers.length - 1]?.item;
        const currentHashItem = routerLocation.hash.replace(/^#/, '');
        if (drawers.length === prevDrawers.length) {
          if (topItem && topItem !== prevTopItem) {
            navigate(`#${topItem}`, { replace: true });
          }
        } else if (drawers.length < prevDrawers.length && prevTopItem === currentHashItem) {
          navigate(-1);
        } else if (drawers.length > prevDrawers.length && topItem) {
          navigate(`#${topItem}`);
        }
      }
    },
    [drawers, routerLocation, prevDrawers],
  );

  const secondTopItem = drawers[drawers.length - 2]?.item;
  useEffect(
    () => {
      const id = routerLocation.hash.replace(/^#/, '');
      if (secondTopItem === id) {
        dispatch(removeActive());
      } else if (!routerLocation.hash && drawers.length > 0) {
        dispatch(removeActive());
      }
    },
    [dispatch, drawers.length, routerLocation, secondTopItem],
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
  const existingMessage = useMessageItem(drawer.item || '');
  const item = existingItem || existingMessage || drawer.newItem;

  const [localItem, setLocalItem] = useState<TypedFlockItem | undefined>(item);
  const handleChange = useCallback(
    (
      data: Partial<Omit<TypedFlockItem, 'type' | 'id'>> | ((prev: TypedFlockItem) => TypedFlockItem),
    ) => setLocalItem(prevItem => {
      if (prevItem) {
        if (typeof data === 'function') {
          return data(prevItem);
        }
        return { ...prevItem, ...data } as TypedFlockItem;
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

    if (isNote(localItem)) {
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

    if (drawer.report) {
      return (
        <MessageDrawer
          message={localItem}
          onBack={onClose}
          onClose={onClose}
          open={drawer.open}
          stacked={stacked}
        />
      );
    }

    return (
      <EditMessageDrawer
        message={localItem}
        onBack={onClose}
        onClose={onClose}
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
  const loggedIn = useLoggedIn();
  const page = usePage();

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

  const showPlaceholder = (
    loggedIn
    && drawers.length === 0
    && baseDrawerIsPermanent
    && !page.noPlaceholderDrawer
  );

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

      {showPlaceholder && (
        <PlaceholderDrawer
          open
          onClose={() => {}}
        />
      )}
    </>
  );
}

export default DrawerDisplay;

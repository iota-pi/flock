import React, { useCallback } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { getItemById, isItem, Item, ItemNote } from '../state/items';
import { DrawerData, removeActive, updateActive } from '../state/ui';
import { useAppDispatch, useAppSelector } from '../store';
import ItemDrawer from './drawers/ItemDrawer';
import PlaceholderDrawer from './drawers/Placeholder';
import ReportDrawer from './drawers/ReportDrawer';
import NoteDrawer from './drawers/NoteDrawer';
import { useItems } from '../state/selectors';

function DrawerDisplay() {
  const dispatch = useAppDispatch();
  const drawers = useAppSelector(state => state.ui.drawers);
  const items = useItems();

  const baseDrawerIsPermanent = useMediaQuery<Theme>(theme => theme.breakpoints.up('lg'));

  const handleExited = useCallback(
    () => dispatch(removeActive()),
    [dispatch],
  );
  const handleClose = useCallback(
    () => {
      if (baseDrawerIsPermanent && drawers.length === 1) {
        handleExited();
      } else {
        dispatch(updateActive({ open: false }));
      }
    },
    [baseDrawerIsPermanent, dispatch, drawers.length, handleExited],
  );
  const handleChange = useCallback(
    (newItem: Item | ItemNote) => {
      dispatch(updateActive({ item: newItem }));
    },
    [dispatch],
  );
  const getItem = useCallback(
    (drawer: DrawerData) => (drawer.item ? getItemById(items, drawer.item.id) : undefined),
    [items],
  );

  const isOpen = useCallback(
    (drawer: DrawerData, i: number) => drawer.open || (baseDrawerIsPermanent && i === 0),
    [baseDrawerIsPermanent],
  );

  return (
    <>
      {drawers.map((drawer, i) => {
        const item = getItem(drawer);
        if (item) {
          if (isItem(item)) {
            return drawer.report ? (
              <ReportDrawer
                item={item}
                key={drawer.id}
                next={drawer.next}
                onClose={handleClose}
                onExited={handleExited}
                open={isOpen(drawer, i)}
                praying={drawer.praying}
                stacked={i > 0}
              />
            ) : (
              <ItemDrawer
                item={item}
                key={drawer.id}
                onChange={handleChange}
                onClose={handleClose}
                onExited={handleExited}
                open={isOpen(drawer, i)}
                stacked={i > 0}
              />
            );
          }

          return (
            <NoteDrawer
              key={drawer.id}
              note={item}
              onChange={handleChange}
              onClose={handleClose}
              onExited={handleExited}
              open={isOpen(drawer, i)}
              stacked={i > 0}
            />
          );
        }

        return null;
      })}

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

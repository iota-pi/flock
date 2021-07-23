import React, { useCallback } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { isItem, Item, ItemNote } from '../state/items';
import { DrawerData, removeActive, updateActive } from '../state/ui';
import { useAppDispatch, useAppSelector } from '../store';
import ItemDrawer from './drawers/ItemDrawer';
import PlaceholderDrawer from './drawers/Placeholder';
import ReportDrawer from './drawers/ReportDrawer';
import NoteDrawer from './drawers/NoteDrawer';

function DrawerDisplay() {
  const dispatch = useAppDispatch();

  const drawers = useAppSelector(state => state.ui.drawers);
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
    (newItem: Item | ItemNote) => dispatch(updateActive({ item: newItem })),
    [dispatch],
  );

  const isOpen = useCallback(
    (drawer: DrawerData, i: number) => drawer.open || (baseDrawerIsPermanent && i === 0),
    [baseDrawerIsPermanent],
  );

  return (
    <>
      {drawers.map((drawer, i) => {
        if (drawer.item) {
          if (isItem(drawer.item)) {
            return drawer.report ? (
              <ReportDrawer
                item={drawer.item}
                key={drawer.id}
                onClose={handleClose}
                onExited={handleExited}
                open={isOpen(drawer, i)}
                stacked={i > 0}
              />
            ) : (
              <ItemDrawer
                item={drawer.item}
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
              note={drawer.item}
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

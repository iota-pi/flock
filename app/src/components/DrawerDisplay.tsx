import React, { useCallback } from 'react';
import { Theme, useMediaQuery } from '@material-ui/core';
import { Item } from '../state/items';
import { removeActive, updateActive } from '../state/ui';
import { useAppDispatch, useAppSelector } from '../store';
import ItemDrawer from './drawers/ItemDrawer';
import PlaceholderDrawer from './drawers/Placeholder';
import ReportDrawer from './drawers/ReportDrawer';

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
    (newItem: Item) => dispatch(updateActive({ item: newItem })),
    [dispatch],
  );

  return (
    <>
      {drawers.map((drawer, i) => drawer.item && (
        drawer.report ? (
          <ReportDrawer
            item={drawer.item}
            key={drawer.id}
            onClose={handleClose}
            onExited={handleExited}
            open={drawer.open || (baseDrawerIsPermanent && i === 0)}
            stacked={i > 0}
          />
        ) : (
          <ItemDrawer
            item={drawer.item}
            key={drawer.id}
            onClose={handleClose}
            onChange={handleChange}
            onExited={handleExited}
            open={drawer.open || (baseDrawerIsPermanent && i === 0)}
            stacked={i > 0}
          />
        )
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

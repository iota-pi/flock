import React, { KeyboardEvent, PropsWithChildren, useCallback } from 'react';
import makeStyles from '@material-ui/core/styles/makeStyles';
import { Drawer } from '@material-ui/core';


const useStyles = makeStyles(theme => ({
  root: {
    flexShrink: 0,
  },
  stacked: {},
  drawerWidth: {
    width: '60%',
    '&$stacked': {
      width: '45%',
    },

    [theme.breakpoints.down('md')]: {
      width: '80%',
      '&$stacked': {
        width: '60%',
      },
    },

    [theme.breakpoints.only('xs')]: {
      width: '100%',
      '&$stacked': {
        width: '100%',
      },
    },
  },
}));

interface Props {
  onClose: () => void,
  open: boolean,
  stacked?: boolean,
}
export type { Props as ItemDrawerProps };


function BaseDrawer({
  children,
  onClose,
  open,
  stacked,
}: PropsWithChildren<Props>) {
  const classes = useStyles();
  const commonClasses = [classes.drawerWidth];
  if (stacked) commonClasses.push(classes.stacked);
  const rootClasses = [classes.root, ...commonClasses];

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      console.warn('called', event);
      if (event.ctrlKey && event.key === 'Enter') {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <Drawer
      className={rootClasses.join(' ')}
      variant="temporary"
      open={open}
      onClose={onClose}
      anchor="right"
      classes={{
        paper: commonClasses.join(' '),
      }}
      onKeyDown={handleKeyDown}
    >
      {children}
    </Drawer>
  );
}

export default BaseDrawer;
